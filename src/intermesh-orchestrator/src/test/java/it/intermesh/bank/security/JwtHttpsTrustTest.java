package it.intermesh.bank.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import io.smallrye.jwt.auth.principal.DefaultJWTParser;
import io.smallrye.jwt.auth.principal.JWTAuthContextInfo;
import io.smallrye.jwt.auth.principal.ParseException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAPublicKey;
import java.time.Instant;
import java.util.Base64;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.jose4j.jwk.RsaJsonWebKey;
import org.jose4j.jws.JsonWebSignature;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JwtHttpsTrustTest {

    @TempDir
    static Path directory;
    static HttpsServer server;
    static KeyPair signingKey;
    static Path trustedCertificate;
    static Path unrelatedCertificate;
    static String issuer;

    @BeforeAll
    static void start() throws Exception {
        char[] password = "synthetic-test-password".toCharArray();
        Path passwordFile = directory.resolve("password");
        Files.writeString(passwordFile, new String(password));
        KeyStore servingKeys = createKeys("serving", passwordFile, password);
        KeyStore unrelatedKeys = createKeys("unrelated", passwordFile, password);
        trustedCertificate = writeCertificate(servingKeys, "serving");
        unrelatedCertificate = writeCertificate(unrelatedKeys, "unrelated");
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(servingKeys, password);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(managers.getKeyManagers(), null, null);
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        signingKey = generator.generateKeyPair();
        RsaJsonWebKey jwk = new RsaJsonWebKey((RSAPublicKey) signingKey.getPublic());
        jwk.setKeyId("synthetic-key");
        byte[] jwks = ("{\"keys\":[" + jwk.toJson() + "]}").getBytes(StandardCharsets.UTF_8);
        server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(tls));
        server.createContext("/realms/intermesh-bank/protocol/openid-connect/certs", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, jwks.length);
            try (var output = exchange.getResponseBody()) {
                output.write(jwks);
            }
        });
        server.start();
        issuer = "https://localhost:" + server.getAddress().getPort() + "/realms/intermesh-bank";
    }

    private static KeyStore createKeys(String alias, Path passwordFile, char[] password) throws Exception {
        Path store = directory.resolve(alias + ".p12");
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair", "-alias", alias, "-keyalg", "RSA", "-keysize", "2048",
                "-dname", "CN=localhost", "-ext", "SAN=dns:localhost", "-validity", "2",
                "-storetype", "PKCS12", "-keystore", store.toString(),
                "-storepass:file", passwordFile.toString())
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        assertEquals(0, process.waitFor(), "Synthetic TLS key generation failed");
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(store)) {
            keys.load(input, password);
        }
        return keys;
    }

    private static Path writeCertificate(KeyStore keys, String alias) throws Exception {
        X509Certificate certificate = (X509Certificate) keys.getCertificate(alias);
        Path path = directory.resolve(alias + ".crt");
        Files.writeString(path, "-----BEGIN CERTIFICATE-----\n"
                + Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(certificate.getEncoded())
                + "\n-----END CERTIFICATE-----\n");
        return path;
    }

    private static DefaultJWTParser parser(Path certificate, String location) {
        JWTAuthContextInfo context = new JWTAuthContextInfo();
        context.setIssuedBy(issuer);
        context.setPublicKeyLocation(location);
        if (certificate != null) {
            context.setTlsCertificatePath(certificate.toString());
        }
        return new DefaultJWTParser(context);
    }

    private static String token(KeyPair key) throws Exception {
        long now = Instant.now().getEpochSecond();
        JsonWebSignature jwt = new JsonWebSignature();
        jwt.setAlgorithmHeaderValue("RS256");
        jwt.setKeyIdHeaderValue("synthetic-key");
        jwt.setKey(key.getPrivate());
        jwt.setPayload("{\"iss\":\"" + issuer + "\",\"sub\":\"subject-alice\","
                + "\"preferred_username\":\"alice\",\"iat\":" + now + ",\"exp\":" + (now + 300) + "}");
        return jwt.getCompactSerialization();
    }

    private static String jwks() {
        return issuer + "/protocol/openid-connect/certs";
    }

    @Test
    void configuredCertificateAllowsVerifiedHttpsJwks() throws Exception {
        assertEquals("alice", parser(trustedCertificate, jwks()).parse(token(signingKey))
                .getClaim("preferred_username"));
    }

    @Test
    void absentCustomTrustRejectsPrivateIssuer() throws Exception {
        assertThrows(ParseException.class, () -> parser(null, jwks()).parse(token(signingKey)));
    }

    @Test
    void unrelatedCertificateRejectsPrivateIssuer() throws Exception {
        assertThrows(ParseException.class, () -> parser(unrelatedCertificate, jwks()).parse(token(signingKey)));
    }

    @Test
    void trustedCertificateDoesNotBypassHostnameVerification() throws Exception {
        String mismatchedHost = jwks().replace("localhost", "127.0.0.1");
        assertThrows(ParseException.class, () -> parser(trustedCertificate, mismatchedHost).parse(token(signingKey)));
    }

    @Test
    void trustedHttpsDoesNotBypassJwtSignatureVerification() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        assertThrows(ParseException.class,
                () -> parser(trustedCertificate, jwks()).parse(token(generator.generateKeyPair())));
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            server.stop(0);
        }
    }
}
