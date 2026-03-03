import {useEffect,useState} from "react";
import {io} from "socket.io-client";

const socket=io("http://localhost:4000");

function App(){

 const [announcements,setAnnouncements]=useState([]);
 const [market,setMarket]=useState("");
 const [sectors,setSectors]=useState({});

 useEffect(()=>{

  socket.on("announcement",(data)=>{

   setAnnouncements(prev=>[
    data,
    ...prev.slice(0,20)
   ]);

   if(data.marketStatus)
    setMarket(data.marketStatus);
  });

  fetch("http://localhost:4000/sectors")
   .then(res=>res.json())
   .then(setSectors);

 },[]);

 return(

 <div style={{
  background:"#020617",
  color:"white",
  minHeight:"100vh",
  padding:"20px",
  fontFamily:"Arial"
 }}>

 <h1>🇮🇳 Market Intelligence Dashboard</h1>

 <h2>
 Market Status :
 <span style={{color:"#22c55e"}}>
  {market}
 </span>
 </h2>

 <hr/>

 <h2>Sector Strength</h2>

 {Object.entries(sectors).map(
 ([sector,value])=>(
  <p key={sector}>
   {sector} : {value.toFixed(2)}
  </p>
 ))}

 <hr/>

 <h2>Live Announcements</h2>

 {announcements.map((a,i)=>(

  <div key={i}
   style={{
    background:"#1e293b",
    marginTop:"10px",
    padding:"15px",
    borderRadius:"8px"
   }}>

   <h3>{a.company}</h3>
   <p>{a.title}</p>
   <p>Sector : {a.sector}</p>
   <p>Strength : {a.strengthScore}</p>

   {a.analysis &&
    <pre>
     {JSON.stringify(
       a.analysis,
       null,
       2
     )}
    </pre>
   }

   <small>{a.time}</small>

  </div>

 ))}

 </div>
 );
}

export default App;