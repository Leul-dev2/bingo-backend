import { io } from "socket.io-client";

const socket = io("http://frontend.bingoogame.com/", {
  autoConnect: false, // we'll connect manually
});

export default socket;
