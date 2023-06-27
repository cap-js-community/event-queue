@protocol: 'rest'
@impl: './../handler/mail-service.js'
service MailService {
    action send(to: String, subject: String, body: String) returns {};
}
