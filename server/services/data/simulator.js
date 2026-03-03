function getSimulatorData(){

 const sectors=[
  "Bank",
  "Pharma",
  "Defense",
  "Railway",
  "Auto"
 ];

 const companies=[
  "SBIN",
  "HAL",
  "BEL",
  "SUNPHARMA",
  "TITAN"
 ];

 return{

  company:
   companies[Math.floor(
    Math.random()*companies.length
   )],

  sector:
   sectors[Math.floor(
    Math.random()*sectors.length
   )],

  profitChange:
   Math.floor(Math.random()*40)-20,

  revenueChange:
   Math.floor(Math.random()*30),

  otherExpense:
   Math.floor(Math.random()*40),

  provisions:
   Math.floor(Math.random()*30),

  newOrders:
   Math.floor(Math.random()*100)
 };

}

module.exports = getSimulatorData;