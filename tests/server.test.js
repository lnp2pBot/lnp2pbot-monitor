const request = require('supertest');

// Listen on an ephemeral port so the test never collides with a dev server
process.env.PORT = '0';

const { app, server } = require('../server');

afterAll((done) => {
  server.close(done);
});

describe('server port selection', () => {
  test('PORT=0 binds a real ephemeral port, not the 3000 default', () => {
    // parseInt('0') is falsy, so a `parseInt(...) || 3000` default silently
    // turns the ephemeral-port request into port 3000 — and this suite would
    // collide with any dev server (the process would die via the
    // uncaughtException handler on EADDRINUSE).
    const address = server.address();
    expect(address.port).toBeGreaterThan(0);
    expect(address.port).not.toBe(3000);
  });
});

describe('server behind App Platform proxy', () => {
  test('trusts exactly one proxy hop so req.ip is the real client', () => {
    // App Platform terminates TLS and forwards with X-Forwarded-For. Without
    // trust proxy, express-rate-limit keys every client on the proxy's IP:
    // the bot's heartbeats, UptimeRobot, and the dashboard share one bucket
    // and can 429 each other (and the library logs a ValidationError on
    // every request carrying the header).
    expect(app.get('trust proxy')).toBe(1);
  });

  test('accepts requests carrying X-Forwarded-For without erroring', async () => {
    const res = await request(app)
      .get('/health')
      .set('X-Forwarded-For', '203.0.113.7');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('health endpoint is not rate limited', async () => {
    // The platform health checker and external monitors poll /health far
    // more often than 100 times per 15 minutes; a 429 here would mark the
    // container unhealthy and restart it.
    const requests = [];
    for (let i = 0; i < 120; i++) {
      requests.push(request(app).get('/health'));
    }
    const responses = await Promise.all(requests);

    expect(responses.every((res) => res.status === 200)).toBe(true);
  });
});
