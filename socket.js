import { io } from "socket.io-client";

const socket = io("http://localhost:5173/", {
  autoConnect: false, // we'll connect manually
});

 export default socket;
