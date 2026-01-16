exports.phoneCall =  (to, from = null, text = null, voice = { name: "Joanna", gender: "female" }) => {
    try {
        let myHeaders = new Headers();
        myHeaders.append("Authorization", "App 4f60e600bb12fd9541288438ae4a4cc9-99c88824-5ca1-45c3-9064-16ab465862be");
        myHeaders.append("Content-Type", "application/json");
        myHeaders.append("Accept", "application/json");

        const raw = JSON.stringify({
            "messages": [
                {
                    "destinations": [{ "to": to || "8801581400711" }],
                    "from": from || "38515507799",
                    "language": "en",
                    "text": text || "You have a new call from " + from,
                    "voice": voice
                }
            ]
        });

        const requestOptions = {
            method: "POST",
            headers: myHeaders,
            body: raw,
            redirect: "follow"
        };

        fetch("https://api.infobip.com/tts/3/advanced", requestOptions)
            .then((response) => response.text())
            .then((result) => console.log(result))
            .catch((error) => console.error(error));


    } catch (error) {
        console.error(error);
    }
}
