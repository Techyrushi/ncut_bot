import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app';
import { User } from '../src/database/models/user.model';
import { RevokedToken } from '../src/database/models/revoked-token.model';
import { Product } from '../src/database/models/product.model';
import { Lead } from '../src/database/models/lead.model';
import { Conversation } from '../src/database/models/conversation.model';
import { Customer } from '../src/database/models/customer.model';
import { Message } from '../src/database/models/message.model';
import { ActivityLog } from '../src/database/models/activity-log.model';
import { BulkCampaign, BulkCampaignRecipient } from '../src/database/models/bulk-campaign.model';
import { WebhookEvent } from '../src/database/models/webhook-event.model';
import { env } from '../src/config/env';
import { enqueueWebhookPayload, processPendingWebhookEvents } from '../src/modules/webhook/webhook.processor';
import { processBulkCampaignQueue } from '../src/modules/bulk-campaigns/bulk-campaign.service';
import { whatsappService } from '../src/modules/whatsapp/whatsapp.service';

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
    Lead.init(),
    Message.init(),
    ActivityLog.init(),
    BulkCampaign.init(),
    BulkCampaignRecipient.init(),
    WebhookEvent.init(),
  ]);
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    RevokedToken.deleteMany({}),
    Product.deleteMany({}),
    Customer.deleteMany({}),
    Conversation.deleteMany({}),
    Lead.deleteMany({}),
    Message.deleteMany({}),
    ActivityLog.deleteMany({}),
    BulkCampaign.deleteMany({}),
    BulkCampaignRecipient.deleteMany({}),
    WebhookEvent.deleteMany({}),
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

it('counts unique customer threads and distinct customer product interests on the dashboard', async () => {
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
  const [returningCustomer, otherCustomer] = await Customer.create([
    { whatsappId: '15550001114', phoneNumber: '15550001114' },
    { whatsappId: '15550001115', phoneNumber: '15550001115' },
  ]);
  const flapProductId = new mongoose.Types.ObjectId();
  const padProductId = new mongoose.Types.ObjectId();
  await Conversation.create([
    {
      customerId: returningCustomer!._id,
      status: 'CLOSED',
      currentStep: 'CLOSED',
      selectedProductIds: [flapProductId],
      uniqueProductCount: 1,
    },
    {
      customerId: returningCustomer!._id,
      status: 'HUMAN_HANDOVER',
      currentStep: 'HUMAN_HANDOVER',
      selectedProductIds: [flapProductId, padProductId],
      uniqueProductCount: 2,
    },
    {
      customerId: otherCustomer!._id,
      status: 'OPEN',
      currentStep: 'WELCOME_SENT',
    },
  ]);

  const result = await request(app).get('/api/v1/dashboard/stats').set('authorization', `Bearer ${token}`);

  expect(result.status).toBe(200);
  expect(result.body.data).toMatchObject({
    totalCustomers: 2,
    totalConversations: 2,
    totalProductSelections: 2,
    humanHandovers: 1,
  });
});

it('filters and exports accurate lead data and supports status and assignment changes', async () => {
  const [admin, sales] = await User.create([
    {
      email: 'admin@example.com',
      name: 'Admin',
      passwordHash: await hash('long-test-password', 4),
      role: 'ADMIN',
    },
    {
      email: 'sales@example.com',
      name: 'Sales Rep',
      passwordHash: await hash('long-test-password', 4),
      role: 'SALES',
    },
  ]);
  const token = jwt.sign({ role: admin!.role, ver: admin!.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin!.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const [customer, otherCustomer] = await Customer.create([
    { whatsappId: '15550001116', phoneNumber: '15550001116', profileName: 'Rushikesh Customer' },
    { whatsappId: '15550001117', phoneNumber: '15550001117', profileName: 'Other Customer' },
  ]);
  const product = await Product.create({
    name: 'Flap Disc',
    slug: 'lead-filter-flap-disc',
    description: 'Grinding and finishing',
    category: 'Abrasives',
  });
  const lead = await Lead.create({
    customerId: customer!._id,
    conversationId: new mongoose.Types.ObjectId(),
    selectedProducts: [product._id],
    assignedSalesPerson: sales!._id,
    status: 'QUALIFIED',
    notificationStatus: 'SENT',
    requirement: '=2+2',
  });
  await Lead.create({
    customerId: otherCustomer!._id,
    conversationId: new mongoose.Types.ObjectId(),
    status: 'NEW',
  });

  const filtered = await request(app)
    .get('/api/v1/leads')
    .query({
      status: 'QUALIFIED',
      assignedSalesPerson: sales!.id,
      search: 'Rushikesh',
      startDate: new Date().toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
    })
    .set('authorization', `Bearer ${token}`);
  expect(filtered.status).toBe(200);
  expect(filtered.body.data.total).toBe(1);
  expect(filtered.body.data.items[0]).toMatchObject({
    _id: lead.id,
    status: 'QUALIFIED',
    notificationStatus: 'SENT',
    requirement: '=2+2',
    customerId: { profileName: 'Rushikesh Customer', phoneNumber: '15550001116' },
    selectedProducts: [{ name: 'Flap Disc' }],
    assignedSalesPerson: { name: 'Sales Rep', isActive: true },
  });

  const csv = await request(app)
    .get('/api/v1/leads/export.csv')
    .query({ status: 'QUALIFIED', assignedSalesPerson: sales!.id, search: 'Rushikesh' })
    .set('authorization', `Bearer ${token}`);
  expect(csv.status).toBe(200);
  expect(csv.headers['content-type']).toContain('text/csv');
  expect(csv.text).toContain('Rushikesh Customer');
  expect(csv.text).toContain('Flap Disc');
  expect(csv.text).toContain(`"'=2+2"`);
  expect(csv.text).not.toContain('Other Customer');

  const requirementSearch = await request(app)
    .get('/api/v1/leads')
    .query({ search: '2+2' })
    .set('authorization', `Bearer ${token}`);
  expect(requirementSearch.body.data.total).toBe(1);
  const assignedFilter = await request(app)
    .get('/api/v1/leads')
    .query({ assignedSalesPerson: 'assigned' })
    .set('authorization', `Bearer ${token}`);
  expect(assignedFilter.body.data.total).toBe(1);
  const invalidDateRange = await request(app)
    .get('/api/v1/leads')
    .query({ startDate: '2026-11-20', endDate: '2026-11-19' })
    .set('authorization', `Bearer ${token}`);
  expect(invalidDateRange.status).toBe(400);

  const status = await request(app)
    .patch(`/api/v1/leads/${lead.id}/status`)
    .set('authorization', `Bearer ${token}`)
    .send({ status: 'WON' });
  expect(status.status).toBe(200);
  expect(status.body.data.status).toBe('WON');
  const unassigned = await request(app)
    .patch(`/api/v1/leads/${lead.id}/assign`)
    .set('authorization', `Bearer ${token}`)
    .send({ userId: '' });
  expect(unassigned.status).toBe(200);
  expect(unassigned.body.data.assignedSalesPerson).toBeUndefined();
  const unassignedFilter = await request(app)
    .get('/api/v1/leads')
    .query({ assignedSalesPerson: 'unassigned' })
    .set('authorization', `Bearer ${token}`);
  expect(unassignedFilter.body.data.total).toBe(2);
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

it('previews bulk recipients with deduplication, consent and service-window safeguards', async () => {
  const admin = await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const token = jwt.sign({ role: admin.role, ver: admin.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const customer = await Customer.create({
    whatsappId: '919175731328',
    phoneNumber: '9175731328',
    optInStatus: 'OPTED_IN',
  });
  await Conversation.create({
    customerId: customer._id,
    status: 'OPEN',
    lastInteractionAt: new Date(),
  });
  const optedOut = await Customer.create({
    whatsappId: '918888888888',
    phoneNumber: '918888888888',
    optInStatus: 'OPTED_OUT',
  });
  const expired = await Customer.create({
    whatsappId: '919999999999',
    phoneNumber: '919999999999',
    optInStatus: 'OPTED_IN',
  });
  await Conversation.create([
    { customerId: optedOut._id, status: 'OPEN', lastInteractionAt: new Date() },
    { customerId: expired._id, status: 'OPEN', lastInteractionAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
  ]);

  const created = await request(app)
    .post('/api/v1/bulk-campaigns')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Preview test', message: 'A business update' });
  expect(created.status).toBe(201);
  const campaignId = created.body.data._id as string;
  const imported = await request(app)
    .post(`/api/v1/bulk-campaigns/${campaignId}/import`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'text/csv')
    .send(Buffer.from('Mobile Number\n9175731328\n+91 91757 31328\n918888888888\n919999999999\n912222222222\nnot-a-number\n'));

  expect(imported.status).toBe(200);
  expect(imported.body.data).toMatchObject({
    rows: 6,
    uniqueRecipients: 5,
    duplicateRows: 1,
    eligible: 1,
    unsent: 4,
  });

  const preview = await request(app)
    .get(`/api/v1/bulk-campaigns/${campaignId}`)
    .set('authorization', `Bearer ${token}`);
  expect(preview.body.data.statusCounts).toMatchObject({ UNSENT: 5 });
  expect(preview.body.data.campaign.status).toBe('READY');

  const queued = await request(app)
    .post(`/api/v1/bulk-campaigns/${campaignId}/send`)
    .set('authorization', `Bearer ${token}`);
  expect(queued.status).toBe(202);
  expect(queued.body.data.queued).toBe(1);
  expect(await BulkCampaignRecipient.countDocuments({ campaignId, status: 'QUEUED' })).toBe(1);
  expect(await BulkCampaignRecipient.countDocuments({ campaignId, status: 'UNSENT' })).toBe(4);
});

it('updates campaign recipient delivery status from the WhatsApp webhook', async () => {
  const admin = await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const customer = await Customer.create({ whatsappId: '919175731329' });
  const conversation = await Conversation.create({ customerId: customer._id });
  const campaign = await BulkCampaign.create({
    name: 'Status test',
    message: 'A business update',
    createdBy: admin._id,
    status: 'PROCESSING',
  });
  const recipient = await BulkCampaignRecipient.create({
    campaignId: campaign._id,
    recipientKey: '919175731329',
    phoneNumber: '919175731329',
    customerId: customer._id,
    sourceRow: 2,
    eligible: true,
    status: 'SENT',
    whatsappMessageId: 'wamid.bulk-status-test',
  });
  await Message.create({
    customerId: customer._id,
    conversationId: conversation._id,
    whatsappMessageId: 'wamid.bulk-status-test',
    bulkCampaignId: campaign._id,
    bulkRecipientId: recipient._id,
    direction: 'OUTBOUND',
    messageType: 'TEXT',
    content: { text: 'A business update' },
    status: 'SENT',
    timestamp: new Date(),
  });

  await enqueueWebhookPayload({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.bulk-status-test', status: 'delivered', timestamp: '1770000000' }] } }] }],
  });
  await processPendingWebhookEvents();

  const updated = await BulkCampaignRecipient.findById(recipient._id).lean();
  expect(updated?.status).toBe('DELIVERED');
  expect(updated?.deliveredAt).toBeInstanceOf(Date);
});

it('imports XLSX recipients and refuses to queue a campaign with no eligible customers', async () => {
  const admin = await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const token = jwt.sign({ role: admin.role, ver: admin.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const created = await request(app)
    .post('/api/v1/bulk-campaigns')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'XLSX preview', message: 'A business update' });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Recipients');
  sheet.addRow(['Mobile Number']);
  sheet.addRow([9175731328]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  const imported = await request(app)
    .post(`/api/v1/bulk-campaigns/${created.body.data._id}/import`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(bytes);
  expect(imported.status).toBe(200);
  expect(imported.body.data).toMatchObject({ rows: 1, eligible: 0, unsent: 1 });

  const send = await request(app)
    .post(`/api/v1/bulk-campaigns/${created.body.data._id}/send`)
    .set('authorization', `Bearer ${token}`);
  expect(send.status).toBe(409);
  expect(send.body.error.code).toBe('NO_ELIGIBLE_RECIPIENTS');
  expect(await BulkCampaignRecipient.countDocuments({ status: 'QUEUED' })).toBe(0);
});

it('rechecks opt-in immediately before delivery and leaves a newly opted-out contact unsent', async () => {
  const admin = await User.create({
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hash('long-test-password', 4),
    role: 'ADMIN',
  });
  const token = jwt.sign({ role: admin.role, ver: admin.authVersion ?? 0 }, env.JWT_SECRET, {
    subject: admin.id,
    jwtid: randomUUID(),
    expiresIn: '1h',
  });
  const customer = await Customer.create({
    whatsappId: '919175731330',
    optInStatus: 'OPTED_IN',
  });
  await Conversation.create({ customerId: customer._id, status: 'OPEN', lastInteractionAt: new Date() });
  const created = await request(app)
    .post('/api/v1/bulk-campaigns')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Consent recheck', message: 'A business update' });
  const campaignId = created.body.data._id as string;
  await request(app)
    .post(`/api/v1/bulk-campaigns/${campaignId}/import`)
    .set('authorization', `Bearer ${token}`)
    .set('content-type', 'text/csv')
    .send(Buffer.from('Phone\n9175731330\n'));
  await request(app)
    .post(`/api/v1/bulk-campaigns/${campaignId}/send`)
    .set('authorization', `Bearer ${token}`);

  await Customer.updateOne({ _id: customer._id }, { $set: { optInStatus: 'OPTED_OUT' } });
  const send = jest.spyOn(whatsappService, 'sendText');
  await processBulkCampaignQueue();

  const recipient = await BulkCampaignRecipient.findOne({ campaignId }).lean();
  expect(recipient?.status).toBe('UNSENT');
  expect(recipient?.reason).toBe('Customer is missing or no longer opted in');
  expect(send).not.toHaveBeenCalled();
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
