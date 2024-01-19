@impl: './service.js'
@protocol: 'none'
service NotificationServiceOutboxedByConfig {
    action sendFiori(to: String, subject: String, body: String);
}
