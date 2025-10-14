import { io } from "socket.io-client";

const socket = io("https://bingo21.netlify.app/", {
  autoConnect: false, // we'll connect manually
});

 export default socket;
