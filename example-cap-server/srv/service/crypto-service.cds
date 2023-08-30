@protocol: 'rest'
@impl: './../handler/crypto-service.js'
service CryptoService {
    action hash(duration: Integer) returns String;
}
