import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

export default function App(){

 const [announcements,setAnnouncements]
 = useState([]);

 useEffect(()=>{

  socket.on(
   "announcement",
   (data)=>{

    setAnnouncements(prev=>[
     data,
     ...prev.slice(0,9)
    ]);
   }
  );

 },[]);

 return(

  <div
   style={{
    background:"#06142b",
    minHeight:"100vh",
    padding:"30px",
    color:"white"
   }}
  >

   <h1>
    🇮🇳 Market Intelligence Dashboard
   </h1>

   <h2>Live Announcements</h2>

   {announcements.map(
    (item,index)=>(

     <div key={index}
      style={{
       background:"#102542",
       padding:"20px",
       margin:"15px 0",
       borderRadius:"10px"
      }}
     >

      <h3>{item.company}</h3>

      <p>Sector: {item.sector}</p>

      <p>
       Verdict:
       <b> {item.verdict}</b>
      </p>

      <p>
       Reason:
       {item.reason}
      </p>

      <p>
       Strength:
       {item.strengthScore}
      </p>

      <p>{item.time}</p>

     </div>

   ))}

  </div>
 );
}