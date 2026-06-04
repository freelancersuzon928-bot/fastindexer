const {google} = require('googleapis');
const fs = require('fs');

const keyData = fs.readFileSync('./service-account.json', 'utf8');
const key = JSON.parse(keyData);

console.log('Email:', key.client_email);
console.log('Key exists:', key.private_key ? 'YES' : 'NO');

const jwt = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ['https://www.googleapis.com/auth/indexing']
});

jwt.authorize((err, t) => {
  if(err) console.log('ERROR:', err.message);
  else console.log('SUCCESS! Auth working!');
});