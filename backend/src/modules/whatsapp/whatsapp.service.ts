import { env, hasWhatsAppConfig } from '../../config/env';
import { Conversation } from '../../database/models/conversation.model';
import { Customer } from '../../database/models/customer.model';
import { ApiError } from '../../utils/api-error';

type WhatsAppApiError = {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
  error_data?: { details?: string };
};
type WhatsAppMessageResponse = { messages?: Array<{ id: string }> };
type WhatsAppPhoneNumberResponse = {
  id?: string;
  status?: string;
  display_phone_number?: string;
  verified_name?: string;
  error?: WhatsAppApiError;
};
type InteractiveButton = { id: string; title: string };
type InteractiveRow = { id: string; title: string; description?: string };

function metaApiError(error: WhatsAppApiError | undefined): ApiError {
  if (error?.code === 200 && error.message?.includes('Cannot call API for app')) {
    return new ApiError(
      502,
      `${error.message}. Meta rejected the app/user authorization for the configured WhatsApp token. Generate a system-user access token from the Meta app connected to this WhatsApp Business Account, assign that user the WABA and phone-number assets, enable whatsapp_business_messaging and whatsapp_business_management, then update WHATSAPP_ACCESS_TOKEN and restart the backend.`,
      'WHATSAPP_APP_AUTHORIZATION_ERROR',
    );
  }
  const details = [
    error?.type,
    typeof error?.code === 'number' ? `code ${error.code}` : undefined,
    typeof error?.error_subcode === 'number' ? `subcode ${error.error_subcode}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return new ApiError(
    502,
    [error?.message ?? 'WhatsApp Cloud API request failed', details].filter(Boolean).join(' · '),
    'WHATSAPP_API_ERROR',
  );
}

export class WhatsAppService {
  private get endpoint(): string {
    if (!hasWhatsAppConfig()) {
      throw new ApiError(503, 'WhatsApp Cloud API credentials are not configured', 'WHATSAPP_NOT_CONFIGURED');
    }
    return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  private async send(to: string, message: Record<string, unknown>): Promise<string> {
    if (message.type !== 'template') await this.assertServiceWindow(to);
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
    });

    const data = (await response.json().catch(() => ({}))) as WhatsAppMessageResponse & {
      error?: WhatsAppApiError;
    };
    if (!response.ok) {
      const error = 'error' in data ? data.error : undefined;
      if (error?.code === 131026) {
        const message = [
            `Meta error 131026: ${error.message ?? 'Message undeliverable'}`,
            error.error_data?.details,
            'Check that the number is correct, registered on WhatsApp, and able to receive messages.',
          ]
            .filter(Boolean)
            .join(' ')
        throw new ApiError(502, message, 'WHATSAPP_API_ERROR');
      }
      throw metaApiError(error);
    }
    const messageId = 'messages' in data ? data.messages?.[0]?.id : undefined;
    if (!messageId) throw new ApiError(502, 'WhatsApp API returned no message identifier', 'WHATSAPP_INVALID_RESPONSE');
    return messageId;
  }

  private async assertServiceWindow(to: string): Promise<void> {
    const customer = await Customer.findOne({ $or: [{ phoneNumber: to }, { whatsappId: to }] }).select('_id');
    const conversation = customer
      ? await Conversation.findOne({
          customerId: customer._id,
          status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
          lastInteractionAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        }).select('_id')
      : null;
    if (!conversation) {
      throw new ApiError(
        409,
        'The 24-hour customer service window has expired; send an approved template instead',
        'SERVICE_WINDOW_EXPIRED',
      );
    }
  }

  async testConnection(): Promise<{
    id?: string;
    status?: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
  }> {
    const url = `${this.endpoint.slice(0, -'/messages'.length)}?fields=id,status,display_phone_number,verified_name`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => ({}))) as WhatsAppPhoneNumberResponse;
    if (!response.ok) {
      throw metaApiError(data.error ?? { message: 'Meta rejected the phone number or access token' });
    }
    return {
      id: data.id,
      status: data.status,
      displayPhoneNumber: data.display_phone_number,
      verifiedName: data.verified_name,
    };
  }

  sendText(to: string, body: string): Promise<string> {
    return this.send(to, { type: 'text', text: { body, preview_url: false } });
  }

  sendImage(to: string, url: string, caption?: string): Promise<string> {
    return this.send(to, { type: 'image', image: { link: url, ...(caption ? { caption } : {}) } });
  }

  sendVideo(to: string, url: string, caption?: string): Promise<string> {
    return this.send(to, { type: 'video', video: { link: url, ...(caption ? { caption } : {}) } });
  }

  sendDocument(to: string, url: string, filename: string, caption?: string): Promise<string> {
    return this.send(to, {
      type: 'document',
      document: { link: url, filename, ...(caption ? { caption } : {}) },
    });
  }

  sendButtons(to: string, body: string, buttons: InteractiveButton[]): Promise<string> {
    if (
      buttons.length < 1 ||
      buttons.length > 3 ||
      buttons.some((button) => !button.title.trim() || button.title.length > 20 || button.id.length > 256)
    ) {
      throw new ApiError(
        400,
        'WhatsApp reply buttons require 1 to 3 items with titles of at most 20 characters',
        'INVALID_INTERACTIVE_MESSAGE',
      );
    }
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } })) },
      },
    });
  }

  sendList(
    to: string,
    body: string,
    buttonText: string,
    sections: Array<{ title: string; rows: InteractiveRow[] }>,
  ): Promise<string> {
    const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
    if (
      rowCount < 1 ||
      rowCount > 10 ||
      sections.length > 10 ||
      sections.some((section) => section.rows.length > 10 || section.title.length > 24) ||
      sections.some((section) => section.rows.some((row) => row.title.length > 24 || row.id.length > 200)) ||
      buttonText.length > 20
    ) {
      throw new ApiError(
        400,
        'WhatsApp interactive list exceeds Meta limits for rows or titles',
        'INVALID_INTERACTIVE_MESSAGE',
      );
    }
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText,
          sections: sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              id: row.id,
              title: row.title,
              ...(row.description ? { description: row.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
  }

  sendTemplate(to: string, name: string, languageCode: string, components?: unknown[]): Promise<string> {
    return this.send(to, {
      type: 'template',
      template: { name, language: { code: languageCode }, ...(components ? { components } : {}) },
    });
  }

  async markRead(messageId: string): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ApiError(502, data.error?.message ?? 'WhatsApp read receipt failed', 'WHATSAPP_API_ERROR');
    }
  }
}

export const whatsappService = new WhatsAppService();
