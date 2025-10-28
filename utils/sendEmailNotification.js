
const axios = require('axios');

let sendEmailNotification = async(email,subject = null, message, senderName) => {

    try {
        const response = await axios.post('https://storefrontsignonline.com/wp-json/connect/v1/send-mail', {
          name: senderName,
          email: email,
          message,
          subject: subject ||  `New message from ${senderName} On Connect`,
        }, {
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if(response.status === 200) {
          console.log('Mail sent successfully');
        } else {
          console.error('Error sending mail:', response.data);
        }
    
      } catch (err) {
        console.error('Error sending mail:', err.response?.data || err.message);
      }
}

module.exports = sendEmailNotification