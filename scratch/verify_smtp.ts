import nodemailer from 'nodemailer';

async function verifySmtp() {
    const transporter = nodemailer.createTransport({
        host: 'smtp.zoho.in',
        port: 587,
        secure: false, // true for 465, false for other ports
        auth: {
            user: 'info@pypecrm.com',
            pass: 'H1a9yMjCbmVk'
        }
    });

    try {
        await transporter.verify();
        console.log("SUCCESS: Connection to smtp.zoho.in works!");
        process.exit(0);
    } catch (error) {
        console.error("FAILED with smtp.zoho.in, trying smtp.zoho.com...", error.message);
        
        const transporterCom = nodemailer.createTransport({
            host: 'smtp.zoho.com',
            port: 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: 'info@pypecrm.com',
                pass: 'H1a9yMjCbmVk'
            }
        });
        
        try {
            await transporterCom.verify();
            console.log("SUCCESS: Connection to smtp.zoho.com works!");
            process.exit(1); // Exit 1 to indicate we need to switch to .com
        } catch (errorCom) {
            console.error("FAILED with smtp.zoho.com as well:", errorCom.message);
            process.exit(2);
        }
    }
}

verifySmtp();
