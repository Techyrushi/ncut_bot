import { hash } from 'bcryptjs';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app';
import { User } from '../src/database/models/user.model';
import { RevokedToken } from '../src/database/models/revoked-token.model';
import { Product } from '../src/database/models/product.model';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), RevokedToken.init(), Product.init()]);
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), RevokedToken.deleteMany({}), Product.deleteMany({})]);
});

it('preserves product fields omitted from an update and rejects empty updates', async () => {
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
    webhookEndpoint: 'http://localhost:5000/api/v1/webhooks/whatsapp',
  });

  const logout = await request(app).post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`);
  expect(logout.status).toBe(200);
  const revoked = await request(app).get('/api/v1/dashboard/stats').set('authorization', `Bearer ${token}`);
  expect(revoked.status).toBe(401);
});
