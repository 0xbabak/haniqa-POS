const { db, init } = require('./db');
const bcrypt = require('bcryptjs');

init().then(() => {
  const username = 'babak';
  const password = 'babak123';
  const hash = bcrypt.hashSync(password, 10);
  db.run(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, hash, 'admin']
  );
  console.log('✓ Admin user created:', username);
  process.exit(0);
});
