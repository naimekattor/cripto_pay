const http = require('http');

const data = 'email=admin%40example.com&password=change-this-password';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/admin/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, res => {
  console.log('statusCode:', res.statusCode);
  console.log('headers:', res.headers);
  res.setEncoding('utf8');
  res.on('data', d => console.log('DATA:', d));
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
