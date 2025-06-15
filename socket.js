import { io } from "socket.io-client";

const socket = io("https://bingobot-backend-bwdo.onrender.com", {
  autoConnect: false, // we'll connect manually
});

export default socket;
