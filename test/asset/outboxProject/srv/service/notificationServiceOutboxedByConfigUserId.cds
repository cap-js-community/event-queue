@impl: './service.js'
@protocol: 'none'
service NotificationServiceOutboxedByConfigUserId {
    action sendFiori(to: String, subject: String, body: String);
}
