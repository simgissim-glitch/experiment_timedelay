// Default Express export for the Vercel adapter; does not open a listening port.
// Local development and tests continue to use server.js/createApp.
module.exports=require('./server').createApp();
