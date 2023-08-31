@protocol: 'rest'
@impl: './../handler/mail-service.js'
service MailService {
    action sendSingle(to: String, subject: String, body: String) returns {};
    action sendClustered(to: String, notificationCode: String) returns {};
}
