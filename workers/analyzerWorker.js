const { subscribe, publish } = require("../server/queue")

function analyze(text){

 const t = text.toLowerCase()

 if(t.includes("growth") || t.includes("record"))
  return "POSITIVE"

 if(t.includes("loss") || t.includes("decline"))
  return "NEGATIVE"

 return "NEUTRAL"

}

subscribe("RESULT_DETECTED",async(data)=>{

 const signal = analyze(data.headline)

 await publish("RESULT_ANALYZED",{

  headline:data.headline,
  signal

 })

 console.log("🧠 RESULT ANALYZED")

})