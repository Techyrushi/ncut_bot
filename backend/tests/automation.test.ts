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
import { env } from '../src/config/env';
import { automationService } from '../src/modules/automation/automation.service';
import { processPendingWebhookEvents, verifySignature } from '../src/modules/webhook/webhook.processor';
import { whatsappService } from '../src/modules/whatsapp/whatsapp.service';
import { webPushService } from '../src/modules/push/web-push.service';

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

let statusEventCounter = 0;

async function markDelivered(whatsappMessageId: string): Promise<void> {
  await WebhookEvent.create({
    eventId: `test-status:${whatsappMessageId}:${++statusEventCounter}`,
    eventType: 'status',
    payload: {
      id: whatsappMessageId,
      status: 'delivered',
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });
  await processPendingWebhookEvents();
}

async function deliverPendingActions(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = await Message.findOne({
      direction: 'OUTBOUND',
      status: 'SENT',
      deliveryActionStatus: 'PENDING',
    })
      .sort({ timestamp: 1, _id: 1 })
      .lean();
    if (!pending?.whatsappMessageId) return;
    await markDelivered(pending.whatsappMessageId);
    const latest = await Message.findById(pending._id).select('deliveryActionStatus').lean();
    if (latest?.deliveryActionStatus === 'PENDING') return;
  }
  throw new Error('Exceeded the expected WhatsApp delivery-action sequence length');
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
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInboundMessageAt: new Date() });
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
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInboundMessageAt: new Date() });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid access token', code: 190 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const error = await whatsappService.sendText('15551112222', 'Hello').catch((requestError: unknown) => requestError);
    expect(error).toMatchObject({ statusCode: 502 });
    expect(error).toHaveProperty('message', 'Invalid access token · code 190');
  });

  it('includes Meta error 131026 details for undeliverable bulk recipients', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInboundMessageAt: new Date() });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Message undeliverable',
            code: 131026,
            error_data: { details: 'Message Undeliverable.' },
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(whatsappService.sendText('15551112222', 'Hello')).rejects.toMatchObject({
      statusCode: 502,
      code: 'WHATSAPP_API_ERROR',
      message: expect.stringContaining(
        'Meta error 131026: Message undeliverable Message Undeliverable.',
      ),
    });

  });

  it('maps Meta error 131047 to the expired service-window response', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInboundMessageAt: new Date() });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(whatsappService.sendText('15551112222', 'Hello')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_WINDOW_EXPIRED',
      message: expect.stringContaining('approved WhatsApp template'),
    });
  });

  it('blocks free-form sends outside the customer service window', async () => {
    const customer = await Customer.create({ whatsappId: '15551112222', phoneNumber: '15551112222' });
    await Conversation.create({
      customerId: customer._id,
      status: 'OPEN',
      lastInboundMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(whatsappService.sendText('15551112222', 'Hello')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_WINDOW_EXPIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks all customer records sharing a phone when finding the active service window', async () => {
    const phone = '15551112224';
    const legacyCustomer = await Customer.create({ whatsappId: 'legacy-user-id', phoneNumber: phone });
    const currentCustomer = await Customer.create({ whatsappId: 'business-scoped-user-id', phoneNumber: phone });
    await Conversation.create({
      customerId: legacyCustomer._id,
      status: 'OPEN',
      lastInboundMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await Conversation.create({
      customerId: currentCustomer._id,
      status: 'OPEN',
      lastInboundMessageAt: new Date(),
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.duplicate-identity' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(whatsappService.sendText(phone, 'Hello')).resolves.toBe('wamid.duplicate-identity');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a native Meta product-list message with catalog retailer IDs', async () => {
    const customer = await Customer.create({ whatsappId: '15551112223', phoneNumber: '15551112223' });
    await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInboundMessageAt: new Date() });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.product-list' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await whatsappService.sendProductList('15551112223', 'catalog-123', 'N-CUT Products', 'Browse products.', [
      {
        title: 'Available products',
        product_items: [{ product_retailer_id: 'flap-disc-sku' }, { product_retailer_id: 'velcro-disc-sku' }],
      },
    ]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'product_list',
        header: { type: 'text', text: 'N-CUT Products' },
        body: { text: 'Browse products.' },
        action: {
          catalog_id: 'catalog-123',
          sections: [
            {
              title: 'Available products',
              product_items: [
                { product_retailer_id: 'flap-disc-sku' },
                { product_retailer_id: 'velcro-disc-sku' },
              ],
            },
          ],
        },
      },
    });
    expect(() =>
      whatsappService.sendProductList('15551112223', 'catalog-123', 'N-CUT Products', 'Browse products.', [
        { title: 'Available products', product_items: Array.from({ length: 31 }, () => ({ product_retailer_id: 'sku' })) },
      ]),
    ).toThrow('between 1 and 30 mapped products');
  });
});

describe('catalogue automation', () => {
  it('sends mapped catalog products in delivery-gated batches of ten', async () => {
    jest.replaceProperty(env, 'WHATSAPP_CATALOG_ID', 'catalog-ncut-test');
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.native-catalog.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const products = await Product.create(
      Array.from({ length: 13 }, (_, index) => ({
        name: `Meta Catalogue Product ${String(index + 1).padStart(2, '0')}`,
        slug: `meta-catalogue-product-${index + 1}`,
        description: `Verified description ${index + 1}`,
        category: 'Abrasives',
        whatsappProductRetailerId: `meta-sku-${index + 1}`,
      })),
    );
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550001013',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { button_reply: { id: selection, title: selection } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('native-catalog-welcome'));
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    await automationService.processIncoming(inbound('native-catalog-open', 'explore_products'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const catalogueImage = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'IMAGE',
      'content.imageUrl': new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString(),
    }).lean();
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      type: 'image',
      image: { link: new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString() },
    });
    await markDelivered(catalogueImage!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(firstPayload).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'product_list',
        body: { text: 'Here are the first 10 products from the catalogue. Select a product to view its photo and full description.' },
        action: {
          catalog_id: 'catalog-ncut-test',
          sections: [{ title: 'Available products' }],
        },
      },
    });
    const firstRetailerIds = firstPayload.interactive.action.sections.flatMap(
      (section: { product_items: Array<{ product_retailer_id: string }> }) =>
        section.product_items.map((item: { product_retailer_id: string }) => item.product_retailer_id),
    );
    expect(firstRetailerIds).toEqual(products.slice(0, 10).map((product) => product.whatsappProductRetailerId));
    expect(
      await Message.countDocuments({
        direction: 'OUTBOUND',
        messageType: 'IMAGE',
        'content.imageUrl': new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString(),
      }),
    ).toBe(1);
  });

  it('lists active catalogue products directly and sends selected image and specifications', async () => {
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.catalogue.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const product = await Product.create({
      name: 'Custom-category flap disc',
      slug: 'custom-category-flap-disc',
      description:
        'For verified metal finishing, grinding and surface preparation with consistent material removal and a clean, durable finish.',
      category: 'Custom Abrasives',
      imageUrl: 'https://cdn.example.test/flap-disc.jpg',
      sizes: ['4"', '5"'],
      grits: ['60', '80'],
      backing: ['Fiber'],
      specifications: { Material: 'Zirconia' },
    });
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550001010',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { button_reply: { id: selection, title: selection } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('msg-welcome'));
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    await automationService.processIncoming(inbound('msg-product-menu', 'explore_products'));
    const catalogueImage = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'IMAGE',
      'content.imageUrl': new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString(),
    }).lean();
    await markDelivered(catalogueImage!.whatsappMessageId!);
    const catalogueImageUrl = new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString();
    const menuImagePayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const menuPayload = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      interactive: {
        body: { text: string };
        action: { sections: Array<{ rows: Array<{ id: string; description?: string }> }> };
      };
    };
    expect(menuImagePayload).toMatchObject({
      type: 'image',
      image: { link: catalogueImageUrl },
    });
    expect(menuPayload.interactive.body.text).toBe(
      'See the catalogue image above, then select a product to see its photo and full description.',
    );
    const productRow = menuPayload.interactive.action.sections[0]?.rows[0];
    expect(productRow).toMatchObject({
      id: `product:${product.id}`,
      title: product.name.slice(0, 24),
    });
    expect(productRow?.description).toMatch(/^For verified metal finishing/);
    expect(productRow?.description?.length).toBeLessThanOrEqual(72);
    expect(productRow?.description?.endsWith('…')).toBe(true);
    expect(productRow?.description).not.toContain('Custom Abrasives');

    await automationService.processIncoming(inbound('msg-product-selected', `product:${product.id}`));
    const sentPayloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(sentPayloads.map((payload) => payload.type)).toEqual([
      'interactive',
      'image',
      'interactive',
      'interactive',
    ]);
    expect(sentPayloads[3]).toMatchObject({
      type: 'interactive',
      interactive: {
        header: { type: 'image', image: { link: product.imageUrl } },
        body: { text: expect.stringContaining(product.name) },
        action: { buttons: expect.any(Array) },
      },
    });
    const messages = await Message.find({ direction: 'OUTBOUND' }).lean();
    expect(messages.some((message) => message.messageType === 'IMAGE' && message.content.imageUrl === product.imageUrl))
      .toBe(false);
    const details = messages.find(
      (message) => message.messageType === 'INTERACTIVE' && message.content.productId?.toString() === product.id,
    );
    expect(details?.content.text).toContain(product.name);
    expect(details?.content.text).toContain(product.description);
    expect(details?.content.text).toContain('What would you like to do next?');
    expect((String(details?.content.text).match(/Custom-category flap disc/g) ?? [])).toHaveLength(1);
    expect(sentPayloads[3]?.interactive?.header?.image).not.toHaveProperty('caption');
  });

  it('waits for media delivery before sending welcome, catalogue, and product follow-ups', async () => {
    let counter = 0;
    const productImageUrl = 'https://cdn.example.test/ordered-flap-disc.jpg';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.ordered.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const product = await Product.create({
      name: 'Ordered Flap Disc',
      slug: 'ordered-flap-disc',
      description: 'Verified product details',
      category: 'Flap Disc',
      imageUrl: productImageUrl,
    });
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550001011',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { button_reply: { id: selection, title: selection } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('ordered-welcome'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: 'interactive',
      interactive: { header: { type: 'image' }, action: { buttons: expect.any(Array) } },
    });
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ type: 'interactive' });
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const catalogueImageUrl = new URL(
      '/ncut-product-catalogue.jpg',
      env.FRONTEND_URL,
    ).toString();
    await automationService.processIncoming(inbound('ordered-menu', 'explore_products'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      type: 'image',
      image: { link: catalogueImageUrl },
    });
    const catalogueImage = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'IMAGE',
      'content.imageUrl': catalogueImageUrl,
    }).lean();
    await markDelivered(catalogueImage!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ type: 'interactive' });

    await automationService.processIncoming(inbound('ordered-product', `product:${product.id}`));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      type: 'interactive',
      interactive: {
        header: { type: 'image', image: { link: productImageUrl } },
        body: { text: expect.stringContaining(product.name) },
        action: { buttons: expect.any(Array) },
      },
    });
    const productDetails = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'INTERACTIVE',
      'content.productId': product.id,
    }).lean();
    await markDelivered(productDetails!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('sends every catalogue product in delivery-gated lists of at most ten rows', async () => {
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.catalogue-pages.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const products = await Product.create(
      Array.from({ length: 13 }, (_, index) => ({
        name: `Catalogue Product ${String(index + 1).padStart(2, '0')}`,
        slug: `catalogue-product-${index + 1}`,
        description: `Description for product ${index + 1}`,
        category: 'Catalogue',
      })),
    );
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550001012',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { button_reply: { id: selection, title: selection } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('paged-welcome'));
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    await automationService.processIncoming(inbound('paged-menu', 'explore_products'));
    const catalogueImage = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'IMAGE',
      'content.imageUrl': new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString(),
    }).lean();
    await markDelivered(catalogueImage!.whatsappMessageId!);

    const productLists = () =>
      Message.find({ direction: 'OUTBOUND', messageType: 'INTERACTIVE', 'content.products': { $exists: true } })
        .sort({ timestamp: 1, _id: 1 })
        .lean();
    let lists = await productLists();
    expect(lists).toHaveLength(1);
    const firstPayloadRows = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).interactive.action.sections[0]
      .rows as Array<{ id: string; title: string }>;
    expect(firstPayloadRows).toHaveLength(10);

    await markDelivered(lists[0]!.whatsappMessageId!);
    lists = await productLists();
    expect(lists).toHaveLength(2);
    const secondRows = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).interactive.action.sections[0].rows as Array<{
      id: string;
      title: string;
    }>;
    expect(secondRows).toHaveLength(3);
    const allRows = [...firstPayloadRows, ...secondRows];
    expect(allRows.map((row) => row.id)).toEqual(products.map((product) => `product:${product.id}`));
    expect(allRows.some((row) => row.title.toLowerCase().includes('more products'))).toBe(false);
  });

  it('sends the welcome image and reply buttons in one interactive message', async () => {
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: `wamid.bsuid.outbound.${++counter}` }] }), {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await markDelivered(welcomeMessage!.whatsappMessageId!);
    const customer = await Customer.findOne({ whatsappId: senderId });
    expect(customer?.phoneNumber).toBeUndefined();
    expect(customer?.optInStatus).toBe('UNKNOWN');
    expect((await Conversation.findOne({ customerId: customer?._id }))?.currentStep).toBe('WELCOME_SENT');
    const payloads = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      to: senderId,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'image',
          image: { link: new URL('/ncut-welcome-message-v2.jpg', env.FRONTEND_URL).toString() },
        },
        body: { text: '👋 Thank you for connecting with us!\n\nExplore our range of abrasive and finishing products.' },
        action: {
          buttons: [
            { reply: { id: 'explore_products', title: 'Explore Our Products' } },
            { reply: { id: 'connect_sales', title: 'Connect With Team' } },
          ],
        },
      },
    });
    expect(await Message.countDocuments({ direction: 'OUTBOUND' })).toBe(1);
    expect(await Message.find({ direction: 'OUTBOUND' }).sort({ _id: 1 }).distinct('messageType')).toEqual(
      ['INTERACTIVE'],
    );
    const welcome = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    expect(welcome?.content).toMatchObject({
      text: '👋 Thank you for connecting with us!\n\nExplore our range of abrasive and finishing products.',
      buttons: [
        { id: 'explore_products', title: 'Explore Our Products' },
        { id: 'connect_sales', title: 'Connect With Team' },
      ],
    });
  });

  it('routes approved-template quick replies through the welcome selections', async () => {
    fakeMetaSend();
    await Product.create({
      name: 'Template button product',
      slug: 'template-button-product',
      description: 'A product selected from the welcome template.',
      category: 'Abrasives',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    await automationService.processIncoming({
      id: 'template-explore',
      from: '15550003340',
      timestamp,
      type: 'button',
      button: { text: 'Explore our products', payload: 'explore_products' },
    });
    const exploreConversation = await Conversation.findOne({
      customerId: (await Customer.findOne({ whatsappId: '15550003340' }))?._id,
    });
    expect(exploreConversation?.currentStep).toBe('PRODUCT_MENU');
    expect(await Message.findOne({ whatsappMessageId: 'template-explore' }).lean()).toMatchObject({
      messageType: 'INTERACTIVE',
      content: { button: { text: 'Explore our products', payload: 'explore_products' } },
    });

    await automationService.processIncoming({
      id: 'template-connect',
      from: '15550003341',
      timestamp,
      type: 'button',
      button: { text: 'Connect with team', payload: 'Connect with team' },
    });
    const connectCustomer = await Customer.findOne({ whatsappId: '15550003341' });
    const connectConversation = await Conversation.findOne({ customerId: connectCustomer?._id });
    expect(connectConversation?.status).toBe('HUMAN_HANDOVER');
    expect(await Lead.findOne({ conversationId: connectConversation?._id })).toMatchObject({
      requirement: 'Customer asked to connect with the sales team',
    });
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
    await deliverPendingActions();

    const conversation = await Conversation.findOne();
    expect(conversation?.uniqueProductCount).toBe(3);
    expect(conversation?.selectedProductIds).toHaveLength(3);
    expect(conversation?.interestTriggeredAt).toBeInstanceOf(Date);
    expect(
      await Message.countDocuments({ direction: 'OUTBOUND', 'content.type': 'product-details-next-steps' }),
    ).toBe(4);
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
    const lead = await Lead.findOne({ conversationId: conversation?._id });
    expect(lead).toMatchObject({
      requirement: 'Customer asked to connect with the sales team',
    });
    expect(await Lead.countDocuments({ conversationId: conversation?._id })).toBe(1);
  });

  it('sends one Direct Send admin alert for each distinct inbound message', async () => {
    const previousProvider = env.SALES_NOTIFICATION_PROVIDER;
    const previousAdminNumber = env.ADMIN_WHATSAPP_NUMBER;
    const previousFrontendUrl = env.FRONTEND_URL;
    const previousVapidPublicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const previousVapidPrivateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY;
    env.SALES_NOTIFICATION_PROVIDER = 'whatsapp';
    env.ADMIN_WHATSAPP_NUMBER = '+919999999999';
    env.FRONTEND_URL = 'https://dashboard.ncut.test';
    env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public-key';
    env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private-key';
    const pushMock = jest.spyOn(webPushService, 'notifyAdmins').mockResolvedValue({ attempted: 1, accepted: 1 });
    const requests: Array<{ url: string; payload: Record<string, unknown>; messageId: string }> = [];
    let counter = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const payload =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const messageId = `wamid.direct.${++counter}`;
      requests.push({ url: String(input), payload, messageId });
      return new Response(JSON.stringify({ messages: [{ id: messageId }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const inbound = {
      id: 'msg-admin-notification',
      from: '15550003332',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Please call me about the flap discs.' },
    };

    try {
      await automationService.processIncoming(inbound);
      const directSend = requests.find(({ payload }) => payload.category === 'utility');
      if (!directSend) throw new Error('Expected one mocked Direct Send request');
      expect(directSend.url).toBe('https://graph.facebook.com/v27.0/123456789/messages');
      expect(directSend.payload).toMatchObject({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '919999999999',
        type: 'interactive',
        category: 'utility',
        interactive: {
          type: 'cta_url',
          header: { type: 'text', text: 'Ncut Admin Notification' },
          body: {
            text: 'Hello Admin,\n\nIncoming WhatsApp message\nCustomer: Please call me about the flap discs.\n\nOpen the notification to review the details in your Ncut dashboard.',
          },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: 'View Notification',
              url: expect.stringMatching(/^https:\/\/dashboard\.ncut\.test\/conversations\?conversation=/),
            },
          },
        },
      });
      const inboundRecord = await Message.findOne({ whatsappMessageId: inbound.id });
      expect(inboundRecord).toMatchObject({
        adminNotificationStatus: 'ACCEPTED',
        adminNotificationMessageId: directSend.messageId,
        webPushStatus: 'ACCEPTED',
      });
      expect(pushMock).toHaveBeenCalledWith({
        title: 'Ncut Admin Notification',
        body: 'Customer: Please call me about the flap discs.',
        url: expect.stringMatching(/^https:\/\/dashboard\.ncut\.test\/conversations\?conversation=/),
      });

      await markDelivered(directSend.messageId);
      expect(await Message.findById(inboundRecord?._id)).toMatchObject({
        adminNotificationStatus: 'ACCEPTED',
        adminNotificationDeliveryStatus: 'DELIVERED',
      });

      const notificationRequestCount = requests.filter(({ payload }) => payload.category === 'utility').length;
      await automationService.processIncoming(inbound);
      expect(requests.filter(({ payload }) => payload.category === 'utility')).toHaveLength(notificationRequestCount);

      await automationService.processIncoming({
        ...inbound,
        id: 'msg-admin-notification-second',
        timestamp: String(Math.floor(Date.now() / 1000)),
        text: { body: 'Can you share product details?' },
      });
      const notifications = requests.filter(({ payload }) => payload.category === 'utility');
      expect(notifications).toHaveLength(notificationRequestCount + 1);
      expect(notifications.at(-1)?.payload).toMatchObject({
        to: '919999999999',
        category: 'utility',
        interactive: {
          body: {
            text: expect.stringContaining('Customer: Can you share product details?'),
          },
        },
      });
      expect(pushMock).toHaveBeenCalledTimes(2);
      expect(pushMock).toHaveBeenLastCalledWith({
        title: 'Ncut Admin Notification',
        body: 'Customer: Can you share product details?',
        url: expect.stringMatching(/^https:\/\/dashboard\.ncut\.test\/conversations\?conversation=/),
      });
    } finally {
      env.SALES_NOTIFICATION_PROVIDER = previousProvider;
      env.ADMIN_WHATSAPP_NUMBER = previousAdminNumber;
      env.FRONTEND_URL = previousFrontendUrl;
      env.WEB_PUSH_VAPID_PUBLIC_KEY = previousVapidPublicKey;
      env.WEB_PUSH_VAPID_PRIVATE_KEY = previousVapidPrivateKey;
    }
  });

  it('offers post-handover options and records lead feedback', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-feedback-handover',
      from: '15550003337',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { button_reply: { id: 'connect_sales', title: 'Connect With Our Team' } },
    });

    await automationService.processIncoming({
      id: 'msg-end-chat',
      from: '15550003337',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { button_reply: { id: 'end_chat', title: 'End Chat' } },
    });

    await automationService.processIncoming({
      id: 'msg-feedback-happy',
      from: '15550003337',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { button_reply: { id: 'feedback_happy', title: 'Happy' } },
    });

    const conversation = await Conversation.findOne();
    expect(conversation?.status).toBe('CLOSED');
    expect(conversation?.currentStep).toBe('CLOSED');
    const lead = await Lead.findOne();
    expect(lead?.feedback).toBe('HAPPY');
    expect(lead?.feedbackAt).toBeInstanceOf(Date);
  });

  it('does not continue pending automated messages after sales handover', async () => {
    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.handover.pending.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const inbound = (id: string, selection?: string) => ({
      id,
      from: '15550003336',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: selection ? 'interactive' : 'text',
      ...(selection
        ? { interactive: { button_reply: { id: selection, title: selection } } }
        : { text: { body: 'Hello' } }),
    });

    await automationService.processIncoming(inbound('msg-before-handover'));
    const welcomeMessage = await Message.findOne({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' }).lean();
    await automationService.processIncoming(inbound('msg-connect-sales', 'connect_sales'));
    expect((await Conversation.findOne())?.status).toBe('HUMAN_HANDOVER');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await markDelivered(welcomeMessage!.whatsappMessageId!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await Message.countDocuments({ direction: 'OUTBOUND', messageType: 'INTERACTIVE' })).toBe(2);
  });

  it('routes Direct Send Contact Sales quick replies to sales handover', async () => {
    fakeMetaSend();
    const customer = await Customer.create({ whatsappId: '15550003337', phoneNumber: '15550003337' });
    const conversation = await Conversation.create({
      customerId: customer._id,
      status: 'OPEN',
      currentStep: 'WELCOME_SENT',
    });

    await automationService.processIncoming({
      id: 'msg-direct-send-contact-sales',
      from: customer.whatsappId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'button',
      button: { payload: 'connect_sales', text: 'Contact Sales' },
    });

    expect((await Conversation.findById(conversation._id))?.status).toBe('HUMAN_HANDOVER');
    expect(await Lead.countDocuments({ customerId: customer._id })).toBe(1);
  });

  it('reuses one customer lead when a returning customer hands over a later conversation', async () => {
    fakeMetaSend();
    const customer = await Customer.create({ whatsappId: '15550003335', phoneNumber: '15550003335' });
    const previousConversation = await Conversation.create({
      customerId: customer._id,
      status: 'CLOSED',
      currentStep: 'CLOSED',
    });
    const lead = await Lead.create({
      customerId: customer._id,
      conversationId: previousConversation._id,
      conversationHistory: [previousConversation._id],
      status: 'CONTACTED',
      adminReadAt: new Date(),
    });
    const returningConversation = await Conversation.create({
      customerId: customer._id,
      status: 'OPEN',
      currentStep: 'WELCOME_SENT',
    });

    await automationService.processIncoming({
      id: 'msg-returning-handover',
      from: customer.whatsappId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { button_reply: { id: 'connect_sales', title: 'Connect With Our Team' } },
    });

    const refreshedLead = await Lead.findById(lead._id);
    expect(await Lead.countDocuments({ customerId: customer._id })).toBe(1);
    expect(refreshedLead?.status).toBe('CONTACTED');
    expect(refreshedLead?.conversationHistory.map(String)).toEqual(
      expect.arrayContaining([String(previousConversation._id), String(returningConversation._id)]),
    );
    expect(refreshedLead?.visitHistory).toHaveLength(1);
    expect(refreshedLead?.visitHistory[0]?.whatsappMessageId).toBe('msg-returning-handover');
    expect(refreshedLead?.requirement).toBe('Customer asked to connect with the sales team');
    expect(refreshedLead?.adminReadAt).toBeUndefined();
  });

  it('restarts automation when a customer messages after sales handover', async () => {
    const customer = await Customer.create({ whatsappId: '15550003334', phoneNumber: '15550003334' });
    const product = await Product.create({
      name: 'Handover Product',
      slug: 'handover-product',
      description: 'Verified product description',
      category: 'Flap Disc',
    });

    const previousActivity = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const conversation = await Conversation.create({
      customerId: customer._id,
      status: 'HUMAN_HANDOVER',
      currentStep: 'HUMAN_HANDOVER',
      selectedProductIds: [product._id],
      uniqueProductCount: 1,
      interestTriggeredAt: previousActivity,
      interestPromptStatus: 'SENT',
      handoverAt: previousActivity,
      lastMessageAt: previousActivity,
      lastInteractionAt: previousActivity,
    });

    let counter = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.handover.restart.${++counter}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const receivedAt = new Date(Math.floor(Date.now() / 1000) * 1000);

    await automationService.processIncoming({
      id: 'msg-during-handover',
      from: customer.whatsappId,
      timestamp: String(receivedAt.getTime() / 1000),
      type: 'text',
      text: { body: 'I have another question' },
    });

    const updatedConversation = await Conversation.findById(conversation._id);
    expect(updatedConversation?.status).toBe('OPEN');
    expect(updatedConversation?.currentStep).toBe('WELCOME_SENT');
    expect(updatedConversation?.selectedProductIds).toHaveLength(0);
    expect(updatedConversation?.uniqueProductCount).toBe(0);
    expect(updatedConversation?.interestTriggeredAt).toBeUndefined();
    expect(updatedConversation?.interestPromptStatus).toBeUndefined();
    expect(updatedConversation?.handoverAt).toBeUndefined();
    expect(updatedConversation?.lastMessageAt).toEqual(receivedAt);
    expect(updatedConversation?.lastInteractionAt).toEqual(receivedAt);
    expect(await Message.countDocuments({ conversationId: conversation._id, direction: 'INBOUND' })).toBe(1);
    expect(await Message.countDocuments({ conversationId: conversation._id, direction: 'OUTBOUND' })).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      type: 'interactive',
      interactive: {
        header: { type: 'image', image: { link: new URL('/ncut-welcome-message-v2.jpg', env.FRONTEND_URL).toString() } },
        action: { buttons: expect.any(Array) },
      },
    });
  });

  it('updates the existing new-chat customer identity when a reply arrives and consolidates duplicates', async () => {
    fakeMetaSend();
    const phone = '918329618662';
    const startedCustomer = await Customer.create({
      whatsappId: phone,
      phoneNumber: phone,
      optInStatus: 'OPTED_IN',
      optInAt: new Date(),
      optInSource: 'Verified website opt-in',
    });
    const startedConversation = await Conversation.create({
      customerId: startedCustomer._id,
      status: 'OPEN',
      currentStep: 'NEW',
    });
    const templateMessage = await Message.create({
      customerId: startedCustomer._id,
      conversationId: startedConversation._id,
      whatsappMessageId: 'wamid.new-chat-template',
      direction: 'OUTBOUND',
      messageType: 'TEMPLATE',
      content: { templateName: 'approved_welcome' },
      status: 'SENT',
      timestamp: new Date(Date.now() - 60_000),
    });
    const duplicateCustomer = await Customer.create({
      whatsappId: 'US.old-user-id',
      phoneNumber: phone,
      optInStatus: 'UNKNOWN',
    });
    const duplicateConversation = await Conversation.create({
      customerId: duplicateCustomer._id,
      status: 'OPEN',
      currentStep: 'NEW',
    });
    const previousInbound = await Message.create({
      customerId: duplicateCustomer._id,
      conversationId: duplicateConversation._id,
      whatsappMessageId: 'wamid.duplicate-inbound',
      direction: 'INBOUND',
      messageType: 'TEXT',
      content: { text: 'Previous reply' },
      status: 'RECEIVED',
      timestamp: new Date(Date.now() - 30_000),
    });

    await automationService.processIncoming({
      id: 'wamid.reply-after-template',
      from: phone,
      from_user_id: 'US.new-user-id',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Yes, I am interested' },
    });

    const customers = await Customer.find({});
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      whatsappId: 'US.new-user-id',
      phoneNumber: phone,
      optInStatus: 'OPTED_IN',
      optInSource: 'Verified website opt-in',
    });
    expect((await Customer.findById(startedCustomer._id))?.id).toBe(startedCustomer.id);
    expect((await Message.findById(templateMessage._id))?.customerId.toString()).toBe(startedCustomer.id);
    expect((await Message.findById(previousInbound._id))?.customerId.toString()).toBe(startedCustomer.id);
    expect((await Conversation.findById(duplicateConversation._id))?.customerId.toString()).toBe(startedCustomer.id);
    expect((await Conversation.findById(duplicateConversation._id))?.status).toBe('CLOSED');
    expect(await Message.countDocuments({ whatsappMessageId: 'wamid.reply-after-template', customerId: startedCustomer._id })).toBe(1);
  });

  it('keeps the newest inbound timestamp when webhooks arrive out of order', async () => {
    fakeMetaSend();
    const customer = await Customer.create({ whatsappId: '15550003336', phoneNumber: '15550003336' });
    const conversation = await Conversation.create({
      customerId: customer._id,
      status: 'HUMAN_HANDOVER',
      currentStep: 'HUMAN_HANDOVER',
    });
    const newest = new Date(Date.now() - 15 * 60 * 60 * 1000);
    const older = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const inbound = (id: string, timestamp: Date) => ({
      id,
      from: customer.whatsappId,
      timestamp: String(Math.floor(timestamp.getTime() / 1000)),
      type: 'text',
      text: { body: 'Checking in' },
    });

    await automationService.processIncoming(inbound('msg-newer', newest));
    await automationService.processIncoming(inbound('msg-older', older));

    const updated = await Conversation.findById(conversation._id);
    expect(updated?.lastInboundMessageAt).toEqual(new Date(Math.floor(newest.getTime() / 1000) * 1000));
    expect(updated?.lastInteractionAt).toEqual(new Date(Math.floor(newest.getTime() / 1000) * 1000));
    expect(await Message.countDocuments({ conversationId: conversation._id, direction: 'INBOUND' })).toBe(2);
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
    const previousConversation = await Conversation.create({
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
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(previousConversation.id);
    expect(conversations[0]?.status).toBe('OPEN');
    expect(conversations[0]?.uniqueProductCount).toBe(0);
    expect(conversations[0]?.currentStep).toBe('WELCOME_SENT');
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

  it('does not send delivery-gated messages when their media fails', async () => {
    fakeMetaSend();
    await automationService.processIncoming({
      id: 'msg-media-failed',
      from: '15550009998',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Hello' },
    });
    const image = await Message.findOne({
      direction: 'OUTBOUND',
      messageType: 'INTERACTIVE',
      'content.imageUrl': new URL('/ncut-welcome-message-v2.jpg', env.FRONTEND_URL).toString(),
    });
    await WebhookEvent.create({
      eventId: `status:${image?.whatsappMessageId}:failed`,
      eventType: 'status',
      payload: {
        id: image?.whatsappMessageId,
        status: 'failed',
        timestamp: String(Math.floor(Date.now() / 1000)),
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      },
    });
    await processPendingWebhookEvents();
    const failedImage = await Message.findById(image?._id);
    expect(failedImage?.status).toBe('FAILED');
    expect(failedImage?.deliveryActionStatus).toBeUndefined();
    expect(await Message.countDocuments({ direction: 'OUTBOUND' })).toBe(1);
  });

  it('retries a failed third-product prompt without incrementing the product count again', async () => {
    let counter = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      counter += 1;
      if (counter === 9) {
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
    await deliverPendingActions();
    await automationService.processIncoming(createSelection('retry-a-msg', products[0]!.id));
    await deliverPendingActions();
    await automationService.processIncoming(createSelection('retry-b-msg', products[1]!.id));
    await deliverPendingActions();
    await automationService.processIncoming(createSelection('retry-c-msg', products[2]!.id));
    await deliverPendingActions();
    expect((await Conversation.findOne())?.interestPromptStatus).toBe('SENT');

    const combinedDetails = await Message.findOne({
      direction: 'OUTBOUND',
      'content.type': 'product-details-next-steps',
    }).lean();
    expect(combinedDetails?.whatsappMessageId).toBeTruthy();
    const conversation = await Conversation.findOne();
    expect(conversation?.uniqueProductCount).toBe(3);
    expect(conversation?.interestPromptStatus).toBe('SENT');
    expect(
      await Message.countDocuments({ direction: 'OUTBOUND', 'content.type': 'product-details-next-steps' }),
    ).toBeGreaterThanOrEqual(1);
  });
});
