@protocol: 'rest'
@impl: './../handler/mail-service.js'
service MailService {
    action sendMail(to: String, subject: String, body: String) returns {};
}
