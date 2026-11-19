import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app';
import { User } from '../src/database/models/user.model';
import { RevokedToken } from '../src/database/models/revoked-token.model';
import { Product } from '../src/database/models/product.model';
import { Conversation } from '../src/database/models/conversation.model';
import { Customer } from '../src/database/models/customer.model';
import { Message } from '../src/database/models/message.model';
import { ActivityLog } from '../src/database/models/activity-log.model';
import { env } from '../src/config/env';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    User.init(),
    RevokedToken.init(),
    Product.init(),
    Customer.init(),
    Conversation.init(),
    Message.init(),
    ActivityLog.init(),
  ]);
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    RevokedToken.deleteMany({}),
    Product.deleteMany({}),
    Customer.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    ActivityLog.deleteMany({}),
  ]);
  jest.restoreAllMocks();
});

it('preserves product fields omitted from an update and rejects empty updates', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const admin = await User.findOne({ email: 'admin@example.com' });
  if (!admin) throw new Error('Test administrator was not created');
  const token = jwt.sign({ role: admin.role, ver: admin.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const product = await Product.create({
    name: 'Verified disc',
    slug: 'verified-disc',
    description: 'Business-approved details',
    category: 'Flap Disc',
    sizes: ['115 mm'],
    grits: ['P60'],
    backing: ['cloth'],
    specifications: { material: 'Verified' },
    isActive: false,
  });

  const update = await request(app)
    .put(`/api/v1/products/${product.id}`)
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Updated disc' });
  expect(update.status).toBe(200);
  expect(update.body.data.name).toBe('Updated disc');
  expect(update.body.data.category).toBe('Flap Disc');
  expect(update.body.data.sizes).toEqual(['115 mm']);
  expect(update.body.data.grits).toEqual(['P60']);
  expect(update.body.data.backing).toEqual(['cloth']);
  expect(update.body.data.specifications).toEqual({ material: 'Verified' });
  expect(update.body.data.isActive).toBe(false);

  const emptyUpdate = await request(app)
    .put(`/api/v1/products/${product.id}`)
    .set('authorization', `Bearer ${token}`)
    .send({});
  expect(emptyUpdate.status).toBe(400);
});

it('tests Meta phone-number connectivity without sending a message', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        id: '123456789',
        status: 'CONNECTED',
        display_phone_number: '+15551234567',
        verified_name: 'Test Business',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

  const result = await request(app)
    .post('/api/v1/whatsapp/configuration/test-connection')
    .set('authorization', `Bearer ${token}`);
  expect(result.status).toBe(200);
  expect(result.body.data).toMatchObject({
    id: '123456789',
    status: 'CONNECTED',
    verifiedName: 'Test Business',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
    '/123456789?fields=id,status,display_phone_number,verified_name',
  );
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
});

it('uploads only image data and accepts documented product category names', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  const invalidImage = await request(app)
    .post('/api/v1/products/image-upload')
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'image/png')
    .send(Buffer.from('not an image'));
  expect(invalidImage.status).toBe(400);

  const product = await request(app)
    .post('/api/v1/products')
    .set('authorization', `Bearer ${token}`)
    .send({
      name: 'Backup Pad',
      slug: 'backup-pad',
      description: 'Verified product details',
      category: 'Velcro & PSA Backup Pads',
    });
  expect(product.status).toBe(201);
  expect(product.body.data.category).toBe('Velcro & PSA Backup Pads');
  const categories = await request(app)
    .get('/api/v1/products/categories')
    .set('authorization', `Bearer ${token}`);
  expect(categories.status).toBe(200);
  expect(categories.body.data).toContain('Velcro & PSA Backup Pads');
});

it('counts inbound unread messages and marks them read through WhatsApp', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  const customer = await Customer.create({ whatsappId: '15550001111', phoneNumber: '15550001111' });
  const conversation = await Conversation.create({ customerId: customer._id });
  await Message.create({
    customerId: customer._id,
    conversationId: conversation._id,
    whatsappMessageId: 'wamid.inbound.1',
    direction: 'INBOUND',
    messageType: 'TEXT',
    content: { text: 'Hello' },
    status: 'RECEIVED',
    timestamp: new Date(),
  });
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

  const before = await request(app).get('/api/v1/conversations').set('authorization', `Bearer ${token}`);
  expect(before.body.data.items[0].unreadCount).toBe(1);
  const read = await request(app)
    .post(`/api/v1/conversations/${conversation.id}/read`)
    .set('authorization', `Bearer ${token}`);
  expect(read.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/123456789/messages'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.inbound.1' }),
    }),
  );
  const after = await request(app).get('/api/v1/conversations').set('authorization', `Bearer ${token}`);
  expect(after.body.data.items[0].unreadCount).toBe(0);
  expect((await Message.findOne({ whatsappMessageId: 'wamid.inbound.1' }))?.status).toBe('READ');
});

it('shows one customer thread with history and unread messages from prior conversations', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  const customer = await Customer.create({ whatsappId: '15550001113', phoneNumber: '15550001113' });
  const previous = await Conversation.create({ customerId: customer._id, status: 'CLOSED', currentStep: 'CLOSED' });
  const current = await Conversation.create({ customerId: customer._id, status: 'OPEN', currentStep: 'PRODUCT_DETAILS' });
  await Message.create([
    {
      customerId: customer._id,
      conversationId: previous._id,
      whatsappMessageId: 'wamid.previous-thread',
      direction: 'INBOUND',
      messageType: 'TEXT',
      content: { text: 'Previous question' },
      status: 'RECEIVED',
      timestamp: new Date(Date.now() - 60_000),
    },
    {
      customerId: customer._id,
      conversationId: current._id,
      whatsappMessageId: 'wamid.current-thread',
      direction: 'INBOUND',
      messageType: 'TEXT',
      content: { text: 'Current question' },
      status: 'RECEIVED',
      timestamp: new Date(),
    },
  ]);
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

  const list = await request(app).get('/api/v1/conversations').set('authorization', `Bearer ${token}`);
  expect(list.body.data.total).toBe(1);
  expect(list.body.data.items).toHaveLength(1);
  expect(list.body.data.items[0]).toMatchObject({ _id: current.id, unreadCount: 2 });

  const history = await request(app)
    .get(`/api/v1/conversations/${current.id}/messages`)
    .set('authorization', `Bearer ${token}`);
  expect(history.body.data.map((message: { content: { text: string } }) => message.content.text)).toEqual([
    'Previous question',
    'Current question',
  ]);

  const read = await request(app)
    .post(`/api/v1/conversations/${current.id}/read`)
    .set('authorization', `Bearer ${token}`);
  expect(read.body.data.readCount).toBe(2);
});

it('resumes automation from sales handover and resets product-flow state', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  const customer = await Customer.create({ whatsappId: '15550001112', phoneNumber: '15550001112' });
  const conversation = await Conversation.create({
    customerId: customer._id,
    status: 'HUMAN_HANDOVER',
    currentStep: 'HUMAN_HANDOVER',
    selectedProductIds: [new mongoose.Types.ObjectId()],
    uniqueProductCount: 1,
    interestTriggeredAt: new Date(),
    interestPromptStatus: 'SENT',
    interestPromptLockedAt: new Date(),
    currentCategory: 'Flap Disc',
  });

  const resumed = await request(app)
    .post(`/api/v1/conversations/${conversation.id}/resume-automation`)
    .set('authorization', `Bearer ${token}`);

  expect(resumed.status).toBe(200);
  expect(resumed.body.data).toMatchObject({
    status: 'OPEN',
    currentStep: 'NEW',
    selectedProductIds: [],
    uniqueProductCount: 0,
  });
  expect(resumed.body.data).not.toHaveProperty('interestTriggeredAt');
  expect(resumed.body.data).not.toHaveProperty('interestPromptStatus');
  expect(resumed.body.data).not.toHaveProperty('interestPromptLockedAt');
  expect(resumed.body.data).not.toHaveProperty('currentCategory');
});

it('filters and searches customer records with pagination metadata', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'long-test-password',
  });
  const token = login.body.data.token as string;
  await Customer.create([
    { whatsappId: '15550001111', profileName: 'Alex Customer', optInStatus: 'OPTED_IN' },
    { whatsappId: '15550002222', profileName: 'Sam Customer', optInStatus: 'OPTED_OUT' },
  ]);

  const filtered = await request(app)
    .get('/api/v1/customers')
    .query({ optInStatus: 'OPTED_IN', search: 'alex', page: 1, limit: 1 })
    .set('authorization', `Bearer ${token}`);
  expect(filtered.status).toBe(200);
  expect(filtered.body.data).toMatchObject({ page: 1, limit: 1, total: 1 });
  expect(filtered.body.data.items).toHaveLength(1);
  expect(filtered.body.data.items[0].profileName).toBe('Alex Customer');

  const invalidFilter = await request(app)
    .get('/api/v1/customers')
    .query({ optInStatus: 'INVALID' })
    .set('authorization', `Bearer ${token}`);
  expect(invalidFilter.status).toBe(400);
});

it('records authenticated write activity and exposes it only to administrators', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const admin = await User.findOne({ email: 'admin@example.com' });
  if (!admin) throw new Error('Test administrator was not created');
  const token = jwt.sign({ role: admin.role, ver: admin.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const created = await request(app)
    .post('/api/v1/products')
    .set('authorization', `Bearer ${token}`)
    .send({
      name: 'Audit test product',
      slug: 'audit-test-product',
      description: 'This body must not be copied to the audit record.',
      category: 'Flap Disc',
    });
  expect(created.status).toBe(201);

  let auditEntry = await ActivityLog.findOne({ source: 'USER', action: /POST .*products/ }).lean();
  for (let attempt = 0; attempt < 20 && !auditEntry; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    auditEntry = await ActivityLog.findOne({ source: 'USER', action: /POST .*products/ }).lean();
  }
  expect(auditEntry).toMatchObject({
    source: 'USER',
    resourceType: 'products',
    actorRole: 'ADMIN',
    statusCode: 201,
  });
  expect(auditEntry?.summary).toBeUndefined();

  const logs = await request(app)
    .get('/api/v1/logs')
    .query({ source: 'USER', search: 'products', page: 1, limit: 10 })
    .set('authorization', `Bearer ${token}`);
  expect(logs.status).toBe(200);
  expect(logs.body.data).toMatchObject({ page: 1, limit: 10, total: 1 });
  expect(logs.body.data.items[0].actorId).toMatchObject({ name: 'Admin', email: 'admin@example.com' });
  expect(logs.body.data.items[0].action).toContain('/products');

  await User.create({
    email: 'sales@example.com',
    name: 'Sales',
    passwordHash: await hash('long-test-password', 4),
    role: 'SALES',
  });
  const sales = await User.findOne({ email: 'sales@example.com' });
  if (!sales) throw new Error('Test sales account was not created');
  const salesToken = jwt.sign({ role: sales.role, ver: sales.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: sales.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const forbidden = await request(app)
    .get('/api/v1/logs')
    .set('authorization', `Bearer ${salesToken}`);
  expect(forbidden.status).toBe(403);

  const anonymous = await request(app).get('/api/v1/logs');
  expect(anonymous.status).toBe(401);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

it('authenticates, enforces protected routes, and revokes a logged-out JWT', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const anonymous = await request(app).get('/api/v1/dashboard/stats');
  expect(anonymous.status).toBe(401);

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin@example.com', password: 'long-test-password' });
  expect(login.status).toBe(200);
  const token = login.body.data.token as string;
  const session = await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
  expect(session.status).toBe(200);
  expect(session.body.data).toMatchObject({
    email: 'admin@example.com',
    name: 'Admin',
    role: 'ADMIN',
  });
  const authorized = await request(app).get('/api/v1/dashboard/stats').set('authorization', `Bearer ${token}`);
  expect(authorized.status).toBe(200);
  const whatsappConfig = await request(app)
    .get('/api/v1/whatsapp/configuration')
    .set('authorization', `Bearer ${token}`);
  expect(whatsappConfig.status).toBe(200);
  expect(whatsappConfig.body.data).toMatchObject({
    sendConfigured: true,
    webhookConfigured: true,
    accessTokenConfigured: true,
    webhookEndpoint: new URL('/api/v1/webhooks/whatsapp', env.APP_URL).toString(),
  });

  const logout = await request(app).post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`);
  expect(logout.status).toBe(200);
  const revoked = await request(app).get('/api/v1/dashboard/stats').set('authorization', `Bearer ${token}`);
  expect(revoked.status).toBe(401);
});

it('updates account credentials with the current password and invalidates prior sessions', async () => {
  await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin@example.com', password: 'long-test-password' });
  const oldToken = login.body.data.token as string;

  const rejected = await request(app)
    .patch('/api/v1/auth/account')
    .set('authorization', `Bearer ${oldToken}`)
    .send({ currentPassword: 'wrong-password', newPassword: 'new-test-password-123' });
  expect(rejected.status).toBe(403);

  const changed = await request(app)
    .patch('/api/v1/auth/account')
    .set('authorization', `Bearer ${oldToken}`)
    .send({
      currentPassword: 'long-test-password',
      email: 'new-admin@example.com',
      newPassword: 'new-test-password-123',
    });
  expect(changed.status).toBe(200);
  expect(changed.body.data.user.email).toBe('new-admin@example.com');

  const oldSession = await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${oldToken}`);
  expect(oldSession.status).toBe(401);

  const oldCredentials = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin@example.com', password: 'long-test-password' });
  expect(oldCredentials.status).toBe(401);

  const newCredentials = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'new-admin@example.com', password: 'new-test-password-123' });
  expect(newCredentials.status).toBe(200);
});
