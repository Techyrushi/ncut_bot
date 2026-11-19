import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app';
import { Conversation } from '../src/database/models/conversation.model';
import { Customer } from '../src/database/models/customer.model';
import { Lead } from '../src/database/models/lead.model';
import { Message } from '../src/database/models/message.model';
import { Product } from '../src/database/models/product.model';
import { WebhookEvent } from '../src/database/models/webhook-event.model';
import { automationService } from '../src/modules/automation/automation.service';
import { processPendingWebhookEvents, verifySignature } from '../src/modules/webhook/webhook.processor';
import { whatsappService } from '../src/modules/whatsapp/whatsapp.service';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    Customer.init(),
    Product.init(),
    Conversation.init(),
    Lead.init(),
    Message.init(),
    WebhookEvent.init(),
  ]);
});

afterEach(async () => {
  await Promise.all([
    Customer.deleteMany({}),
    Lead.deleteMany({}),
    Product.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
  jest.restoreAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function fakeMetaSend(): void {
  let counter = 0;
  jest.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ messages: [{ id: `wamid.test.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('WhatsApp webhook', () => {
  it('verifies the GET challenge only for the configured verify token', async () => {
    const accepted = await request(app)
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'challenge-123' });
    expect(accepted.status).toBe(200);
    expect(accepted.text).toBe('challenge-123');

    const rejected = await request(app)
      .get('/api/v1/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'challenge-123' });
    expect(rejected.status).toBe(403);
  });

  it('validates raw-body signatures and durably deduplicates callback messages', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.in.1',
                      from: '15550001111',
                      timestamp: '1760000000',
                      type: 'text',
                      text: { body: 'Hello' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const signature = `sha256=${createHmac('sha256', 'test-meta-app-secret').update(raw).digest('hex')}`;
    expect(verifySignature(raw, signature)).toBe(true);
    expect(verifySignature(raw, 'sha256=deadbeef')).toBe(false);

    const body = raw.toString('utf8');
    const invalid = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=bad')
      .set('content-type', 'application/json')
      .send(body);
    expect(invalid.status).toBe(401);
    const first = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('x-hub-signature-256', signature)
      .set('content-type', 'application/json')
      .send(body);
    const duplicate = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('x-hub-signature-256', signature)
      .set('content-type', 'application/json')
      .send(body);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await WebhookEvent.countDocuments()).toBe(1);
  });
});

describe('Meta Cloud API service', () => {
  it('sends supported message payloads and returns Meta message identifiers', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInteractionAt: new Date() });
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: `wamid.service.${++counter}` }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(whatsappService.sendText('15551112222', 'Hello')).resolves.toBe('wamid.service.1');
    await whatsappService.sendImage('15551112222', 'https://example.test/image.jpg', 'Verified image');
    await whatsappService.sendButtons('15551112222', 'Choose', [{ id: 'connect_sales', title: 'Connect' }]);
    await whatsappService.sendList('15551112222', 'Select', 'Browse', [
      { title: 'Products', rows: [{ id: 'product:a', title: 'Product A' }] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v27.0/123456789/messages');
    expect(options?.headers).toMatchObject({ authorization: 'Bearer test-access-token' });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '15551112222',
      type: 'text',
    });
    expect(() =>
      whatsappService.sendButtons('15551112222', 'Too many', [
        { id: 'one', title: 'One' },
        { id: 'two', title: 'Two' },
        { id: 'three', title: 'Three' },
        { id: 'four', title: 'Four' },
      ]),
    ).toThrow('titles of at most 20 characters');
  });

  it('surfaces Meta API failures rather than returning a fake success', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInteractionAt: new Date() });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid access token', code: 190 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(whatsappService.sendText('15551112222', 'Hello')).rejects.toMatchObject({
      statusCode: 502,
      message: 'Invalid access token',
    });
  });

  it('blocks free-form sends outside the customer service window', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({
      customerId: customer._id,
      status: 'OPEN',
      lastInteractionAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(whatsappService.sendText('15551112222', 'Hello')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_WINDOW_EXPIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('catalogue automation', () => {
  it('handles Meta business-scoped sender IDs when phone numbers are omitted', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.bsuid.outbound' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const senderId = 'US.13491208655302741918';
    await automationService.processIncoming({
      id: 'wamid.bsuid.1',
      from_user_id: senderId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Hello' },
    });

    const customer = await Customer.findOne({ whatsappId: senderId });
    expect(customer?.phoneNumber).toBeUndefined();
    expect((await Conversation.findOne({ customerId: customer?._id }))?.currentStep).toBe('WELCOME_SENT');
    expect(await Message.countDocuments({ direction: 'OUTBOUND' })).toBe(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ to: senderId });
  });

  it('counts unique product interests atomically and sends the third-interest prompt once', async () => {
    fakeMetaSend();
    const products = await Product.create([
      { name: 'Flap Product A', slug: 'flap-a', description: 'Verified A description', category: 'Flap Disc' },
      { name: 'Flap Product B', slug: 'flap-b', description: 'Verified B description', category: 'Flap Disc' },
      { name: 'Flap Product C', slug: 'flap-c', description: 'Verified C description', category: 'Flap Disc' },
    ]);
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550002222',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { list_reply: { id: selection, title: 'selected' } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('msg-welcome'));
    for (const product of products) {
      await automationService.processIncoming(inbound(`msg-${product.id}`, `product:${product.id}`));
    }
    await automationService.processIncoming(inbound('msg-repeat', `product:${products[0]!.id}`));

    const conversation = await Conversation.findOne();
    expect(conversation?.uniqueProductCount).toBe(3);
    expect(conversation?.selectedProductIds).toHaveLength(3);
    expect(conversation?.interestTriggeredAt).toBeInstanceOf(Date);
    expect(
      await Message.countDocuments({ direction: 'OUTBOUND', 'content.type': 'third-product-interest-trigger' }),
    ).toBe(1);
  });

  it('hands a customer to sales and creates only one lead', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-handover',
      from: '15550003333',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { button_reply: { id: 'connect_sales', title: 'Connect With Our Team' } },
    });
    const conversation = await Conversation.findOne();
    expect(conversation?.status).toBe('HUMAN_HANDOVER');
    expect(await Lead.countDocuments({ conversationId: conversation?._id })).toBe(1);
  });

  it('records an opt-out and stops subsequent automation', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-stop',
      from: '15550004444',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'STOP' },
    });
    const customer = await Customer.findOne();
    expect(customer?.optInStatus).toBe('OPTED_OUT');
    expect(await Message.countDocuments({ direction: 'OUTBOUND' })).toBe(0);
  });

  it('expires stale sessions and starts a fresh conversation', async () => {
    fakeMetaSend();
    const customer = await Customer.create({ whatsappId: '15550006666', phoneNumber: '15550006666' });
    await Conversation.create({
      customerId: customer._id,
      status: 'OPEN',
      currentStep: 'PRODUCT_DETAILS',
      uniqueProductCount: 2,
      lastInteractionAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    await automationService.processIncoming({
      id: 'msg-after-expiry',
      from: customer.whatsappId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Hello again' },
    });
    const conversations = await Conversation.find({ customerId: customer._id }).sort({ createdAt: 1 });
    expect(conversations).toHaveLength(2);
    expect(conversations[0]?.status).toBe('CLOSED');
    expect(conversations[1]?.uniqueProductCount).toBe(0);
    expect(conversations[1]?.currentStep).toBe('WELCOME_SENT');
  });

  it('handles invalid product identifiers without counting an interest', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-invalid-product',
      from: '15550007777',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { list_reply: { id: 'product:not-an-object-id', title: 'Invalid' } },
    });
    expect((await Conversation.findOne())?.uniqueProductCount).toBe(0);
    expect(await Message.countDocuments({ direction: 'OUTBOUND' })).toBe(1);
  });

  it('resets unique product tracking when the customer restarts the menu', async () => {
    fakeMetaSend();
    const product = await Product.create({
      name: 'Restart Product',
      slug: 'restart-product',
      description: 'Verified details',
      category: 'Flap Disc',
    });
    await automationService.processIncoming({
      id: 'msg-before-restart',
      from: '15550008888',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { list_reply: { id: `product:${product.id}`, title: product.name } },
    });
    await automationService.processIncoming({
      id: 'msg-restart',
      from: '15550008888',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'restart' },
    });
    expect((await Conversation.findOne())?.uniqueProductCount).toBe(0);
    expect((await Conversation.findOne())?.currentStep).toBe('WELCOME_SENT');
  });

  it('processes a persisted webhook event through the worker', async () => {
    fakeMetaSend();
    await WebhookEvent.create({
      eventId: 'message:wamid.worker.1',
      eventType: 'message',
      payload: {
        message: {
          id: 'wamid.worker.1',
          from_user_id: 'US.13491208655302741919',
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'Hi' },
        },
        contacts: [{ user_id: 'US.13491208655302741919', profile: { name: 'Webhook User' } }],
      },
    });
    await processPendingWebhookEvents();
    expect((await WebhookEvent.findOne())?.processingStatus).toBe('PROCESSED');
    expect(await Customer.countDocuments()).toBe(1);
    expect(await Customer.findOne()).toMatchObject({
      whatsappId: 'US.13491208655302741919',
      profileName: 'Webhook User',
    });
  });

  it('updates outbound delivery status from a signed webhook event', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-for-status',
      from: '15550009999',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Hello' },
    });
    const outbound = await Message.findOne({ direction: 'OUTBOUND' });
    expect(outbound?.whatsappMessageId).toBeTruthy();
    await WebhookEvent.create({
      eventId: `status:${outbound?.whatsappMessageId}:delivered`,
      eventType: 'status',
      payload: {
        id: outbound?.whatsappMessageId,
        status: 'delivered',
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    });
    await processPendingWebhookEvents();
    expect((await Message.findById(outbound?._id))?.status).toBe('DELIVERED');
  });

  it('retries a failed third-product prompt without incrementing the product count again', async () => {
    let counter = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      counter += 1;
      if (counter === 8) {
        return new Response(JSON.stringify({ error: { message: 'Temporary API failure' } }), { status: 500 });
      }
      return new Response(JSON.stringify({ messages: [{ id: `wamid.retry.${counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const products = await Product.create([
      { name: 'Retry Product A', slug: 'retry-a', description: 'Verified A', category: 'Flap Disc' },
      { name: 'Retry Product B', slug: 'retry-b', description: 'Verified B', category: 'Flap Disc' },
      { name: 'Retry Product C', slug: 'retry-c', description: 'Verified C', category: 'Flap Disc' },
    ]);
    const createSelection = (id: string, productId: string) => ({
      id,
      from: '15550001010',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { list_reply: { id: `product:${productId}`, title: 'Product' } },
    });
    await automationService.processIncoming({
      id: 'retry-welcome',
      from: '15550001010',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Hello' },
    });
    await automationService.processIncoming(createSelection('retry-a-msg', products[0]!.id));
    await automationService.processIncoming(createSelection('retry-b-msg', products[1]!.id));
    await expect(
      automationService.processIncoming(createSelection('retry-c-msg', products[2]!.id)),
    ).rejects.toMatchObject({
      statusCode: 502,
    });
    expect((await Conversation.findOne())?.interestPromptStatus).toBe('PENDING');

    await automationService.processIncoming(createSelection('retry-c-again', products[2]!.id));
    const conversation = await Conversation.findOne();
    expect(conversation?.uniqueProductCount).toBe(3);
    expect(conversation?.interestPromptStatus).toBe('SENT');
    expect(
      await Message.countDocuments({ direction: 'OUTBOUND', 'content.type': 'third-product-interest-trigger' }),
    ).toBe(1);
  });
});
