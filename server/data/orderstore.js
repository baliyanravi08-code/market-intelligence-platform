/*
====================================
COMPANY ORDER DATABASE (MEMORY)
====================================
*/

const companyOrders={};

function updateOrderBook(company,value){

 if(!companyOrders[company]){

  companyOrders[company]={
   totalOrderValue:0,
   orders:0
  };
 }

 companyOrders[company].totalOrderValue+=value;
 companyOrders[company].orders+=1;

 return companyOrders[company];
}

function getOrderBook(){
 return companyOrders;
}

module.exports={
 updateOrderBook,
 getOrderBook
};