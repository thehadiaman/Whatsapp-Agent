import { prepareTestDatabase } from '../src/testing.js';

export default async function setup(): Promise<void> {
  await prepareTestDatabase();
}
