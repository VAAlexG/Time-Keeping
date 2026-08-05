import { hashPassword } from '../server/auth';

const password = process.env.TIMEKEEPING_PASSWORD;
if (!password) {
  console.error('Set TIMEKEEPING_PASSWORD in the current shell, then run this command again.');
  process.exit(1);
}
console.log(await hashPassword(password));
