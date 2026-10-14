// Prints the hash for the recording management page password (api.ui_password_hash).
// Usage: node scripts/recording-ui-password.ts < password-file   (the password is never echoed)
import { readFileSync } from 'node:fs';
import { hashUiPassword } from '../src/recording/api.ts';

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('password must have at least 12 characters');
  process.exit(1);
}
console.log(hashUiPassword(password));
