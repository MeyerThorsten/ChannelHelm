import { ulid } from 'ulid';

export type IdPrefix = 'brd' | 'src' | 'pkg' | 'ast';

export function makeId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
