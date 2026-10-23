import { StreamLimit } from './stream-limit';

const limit = (perIp: number, total: number) =>
  new StreamLimit({
    get: (key: string) => (key === 'STREAMS_PER_IP' ? perIp : total),
  } as never);

it('refuses a stream past the per-address cap and frees a slot on release', () => {
  const streams = limit(2, 10);
  const first = streams.acquire('a');
  expect(streams.acquire('a')).not.toBeNull();
  expect(streams.acquire('a')).toBeNull();
  expect(streams.acquire('b')).not.toBeNull();
  first?.();
  expect(streams.acquire('a')).not.toBeNull();
});

it('refuses a stream past the total cap', () => {
  const streams = limit(5, 2);
  expect(streams.acquire('a')).not.toBeNull();
  expect(streams.acquire('b')).not.toBeNull();
  expect(streams.acquire('c')).toBeNull();
});

it('frees a slot only once however often its release is called', () => {
  const streams = limit(2, 2);
  const release = streams.acquire('a');
  streams.acquire('a');
  release?.();
  release?.();
  expect(streams.acquire('a')).not.toBeNull();
  expect(streams.acquire('a')).toBeNull();
});
