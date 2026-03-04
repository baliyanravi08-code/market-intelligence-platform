const mongoose = require("mongoose")

const ResultSchema = new mongoose.Schema({

 company:{
  type:String,
  required:true
 },

 sector:{
  type:String
 },

 signal:{
  type:String
 },

 analysis:{
  type:String
 },

 time:{
  type:Date,
  default:Date.now
 }

})

module.exports = mongoose.model("Result",ResultSchema)