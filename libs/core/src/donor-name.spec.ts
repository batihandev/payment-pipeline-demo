import { donorName } from './donor-name';

const first = `0x${'ab'.repeat(20)}`;
const second = `0x${'cd'.repeat(20)}`;

it('gives the same name for an address in any case', () => {
  expect(donorName(first.toUpperCase().replace('0X', '0x'))).toBe(
    donorName(first),
  );
});
it('names in two capitalised words', () => {
  expect(donorName(first)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
});
it('names two different addresses differently', () => {
  expect(donorName(first)).not.toBe(donorName(second));
});
