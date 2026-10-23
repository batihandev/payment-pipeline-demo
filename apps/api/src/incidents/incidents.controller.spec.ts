import request from 'supertest';
import { useReadApi } from '../../testing/read-api';

const state = useReadApi();
const get = (url: string) => request(state.app.getHttpServer()).get(url);

it('returns newest incidents and rejects limits outside one to one hundred', async () => {
  for (const day of [19, 20])
    await state.database.db.incident.create({
      data: {
        kind: 'duplicate',
        whatHappened: `Day ${day}`,
        howHandled: 'Skipped',
        createdAt: new Date(`2026-10-${day}T00:00:00Z`),
      },
    });
  const response = await get('/incidents?limit=1');
  expect(response.body).toEqual([
    expect.objectContaining({ whatHappened: 'Day 20' }),
  ]);
  for (const limit of ['0', '101', 'abc', '1.5'])
    expect((await get(`/incidents?limit=${limit}`)).statusCode).toBe(400);
});
it('answers 400 bad_request for an out-of-range or non-integer limit', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5']) {
    const response = await get(`/incidents?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad_request' });
  }
});
it('ignores unknown query parameters', async () => {
  const response = await get('/incidents?other=1');
  expect(response.statusCode).toBe(200);
});
