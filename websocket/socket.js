import socketio from 'socket.io-client';

const socket = socketio('http://localhost:3000', {
  transports: ['websocket'],
});

