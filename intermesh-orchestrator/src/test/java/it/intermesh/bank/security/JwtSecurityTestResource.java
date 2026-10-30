package it.intermesh.bank.security;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.quarkus.test.common.QuarkusTestResourceLifecycleManager;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class JwtSecurityTestResource implements QuarkusTestResourceLifecycleManager {

    private final ObjectMapper json = new ObjectMapper();
    private final AtomicInteger ledgerCalls = new AtomicInteger();
    private final AtomicInteger jwksCalls = new AtomicInteger();
    private final AtomicInteger fraudCalls = new AtomicInteger();
    private final AtomicInteger accountLookups = new AtomicInteger();
    private final AtomicInteger historyCalls = new AtomicInteger();
    private final AtomicReference<String> lastLookupAccount = new AtomicReference<>("");
    private final AtomicReference<String> lastHistoryAccount = new AtomicReference<>("");
    private final AtomicReference<String> lastOwner = new AtomicReference<>("");
    private HttpServer server;
    private URI baseUri;
    private KeyPair signingKey;
    private KeyPair untrustedKey;
    private ExecutorService executor;
    private volatile CountDownLatch blocked = new CountDownLatch(0);
    private volatile CountDownLatch release = new CountDownLatch(0);

    @Override
    public Map<String, String> start() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            signingKey = generator.generateKeyPair();
            untrustedKey = generator.generateKeyPair();
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            executor = Executors.newCachedThreadPool();
            server.setExecutor(executor);
            baseUri = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
            server.createContext("/realms/intermesh-bank/protocol/openid-connect/certs", this::jwks);
            server.createContext("/test/token", this::token);
            server.createContext("/test/reset", exchange -> {
                ledgerCalls.set(0);
                fraudCalls.set(0);
                accountLookups.set(0);
                historyCalls.set(0);
                lastLookupAccount.set("");
                lastHistoryAccount.set("");
                lastOwner.set("");
                release.countDown();
                blocked = new CountDownLatch(0);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
            server.createContext("/test/ledger-calls", exchange -> respond(exchange, 200,
                    Map.of("count", ledgerCalls.get(), "owner", lastOwner.get(), "jwksCalls", jwksCalls.get(),
                            "fraudCalls", fraudCalls.get(), "blocked", blocked.getCount() == 0,
                            "accountLookups", accountLookups.get(), "historyCalls", historyCalls.get(),
                            "lookupAccount", lastLookupAccount.get(), "historyAccount", lastHistoryAccount.get())));
            server.createContext("/test/block", exchange -> {
                blocked = new CountDownLatch(1);
                release = new CountDownLatch(1);
                respond(exchange, 200, Map.of());
            });
            server.createContext("/test/release", exchange -> {
                release.countDown();
                respond(exchange, 200, Map.of());
            });
            server.createContext("/v1/ledger", this::ledger);
            server.createContext("/v2/fraud", exchange -> {
                fraudCalls.incrementAndGet();
                respond(exchange, 200, Map.of());
            });
            server.start();
            return Map.of(
                    "mp.jwt.verify.issuer", baseUri + "/realms/intermesh-bank",
                    "ledger-service/mp-rest/url", baseUri.toString(),
                    "fraud-service/mp-rest/url", baseUri.toString(),
                    "quarkus.http.session.timeout", "PT10S");
        } catch (IOException | GeneralSecurityException e) {
            stop();
            throw new IllegalStateException("Cannot start synthetic JWT test fixtures", e);
        }
    }

    @Override
    public void inject(TestInjector injector) {
        injector.injectIntoFields(baseUri, new TestInjector.MatchesType(URI.class));
    }

    @Override
    public void stop() {
        release.countDown();
        if (server != null) {
            server.stop(0);
        }
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void jwks(HttpExchange exchange) throws IOException {
        jwksCalls.incrementAndGet();
        RSAPublicKey key = (RSAPublicKey) signingKey.getPublic();
        respond(exchange, 200, Map.of("keys", List.of(Map.of(
                "kty", "RSA", "use", "sig", "alg", "RS256", "kid", "synthetic-key",
                "n", unsigned(key.getModulus()), "e", unsigned(key.getPublicExponent())))));
    }

    private String unsigned(BigInteger value) {
        byte[] bytes = value.toByteArray();
        if (bytes[0] == 0) {
            bytes = Arrays.copyOfRange(bytes, 1, bytes.length);
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private void token(HttpExchange exchange) throws IOException {
        Map<String, Object> claims = json.readValue(exchange.getRequestBody(), new TypeReference<>() {});
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        String header = encoder.encodeToString(json.writeValueAsBytes(
                Map.of("alg", "RS256", "typ", "JWT", "kid", "synthetic-key")));
        String payload = encoder.encodeToString(json.writeValueAsBytes(claims));
        String input = header + "." + payload;
        try {
            Signature signer = Signature.getInstance("SHA256withRSA");
            boolean invalidSignature = exchange.getRequestURI().getPath().endsWith("/invalid-signature");
            signer.initSign((invalidSignature ? untrustedKey : signingKey).getPrivate());
            signer.update(input.getBytes(StandardCharsets.US_ASCII));
            byte[] body = (input + "." + encoder.encodeToString(signer.sign()))
                    .getBytes(StandardCharsets.US_ASCII);
            exchange.getResponseHeaders().set("Content-Type", "text/plain");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        } catch (GeneralSecurityException e) {
            throw new IOException("Cannot sign synthetic test token", e);
        }
    }

    private void ledger(HttpExchange exchange) throws IOException {
        ledgerCalls.incrementAndGet();
        String prefix = "/v1/ledger/accounts/";
        String path = exchange.getRequestURI().getRawPath();
        if (exchange.getRequestMethod().equals("POST")) {
            if (path.equals("/v1/ledger/accounts")) {
                Map<String, Object> request = json.readValue(exchange.getRequestBody(), new TypeReference<>() {});
                String owner = (String) request.get("user_id");
                lastOwner.set(owner);
                respond(exchange, 200, account(owner));
            } else {
                respond(exchange, 200, Map.of("status", "COMMITTED", "transaction_id", "TX-TEST"));
            }
            return;
        }
        String accountPrefix = "/v1/ledger/account/";
        if (exchange.getRequestMethod().equals("GET") && path.startsWith(accountPrefix)) {
            if (path.endsWith("/balance")) {
                String id = URLDecoder.decode(path.substring(accountPrefix.length(), path.length() - "/balance".length()),
                        StandardCharsets.UTF_8);
                accountLookups.incrementAndGet();
                lastLookupAccount.set(id);
                if (id.equals("ACC-MISSING")) {
                    respond(exchange, 404, Map.of("error", "Synthetic upstream detail"));
                } else if (id.equals("ACC-LOOKUP-500") || id.equals("ACC-LOOKUP-503")) {
                    respond(exchange, id.endsWith("500") ? 500 : 503, Map.of("error", "Synthetic upstream detail"));
                } else if (id.equals("ACC-NULL")) {
                    respond(exchange, 200, null);
                } else if (id.equals("ACC-NO-OWNER")) {
                    respond(exchange, 200, Map.of("account_id", id));
                } else if (id.equals("ACC-WRONG-ID")) {
                    respond(exchange, 200, account("user-a", "ACC-OTHER"));
                } else {
                    String owner = switch (id) {
                        case "ACC-BOB" -> "user-b";
                        case "ACC-CASE" -> "User-A";
                        case "ACC-PADDED" -> " user-a ";
                        case "ACC-BLANK-OWNER" -> " ";
                        default -> "user-a";
                    };
                    respond(exchange, 200, account(owner, id));
                }
                return;
            }
            if (path.endsWith("/transactions")) {
                String id = URLDecoder.decode(path.substring(accountPrefix.length(), path.length() - "/transactions".length()),
                        StandardCharsets.UTF_8);
                historyCalls.incrementAndGet();
                lastHistoryAccount.set(id);
                if (id.equals("ACC-HISTORY-FAIL")) {
                    respond(exchange, 503, Map.of("error", "Synthetic upstream detail"));
                } else if (id.equals("ACC-NULL-HISTORY")) {
                    respond(exchange, 200, null);
                } else if (id.equals("ACC-TEST") || id.equals("ACC-EMPTY")) {
                    respond(exchange, 200, List.of());
                } else {
                    respond(exchange, 200, List.of(Map.of("transaction_id", "TX-" + id,
                            "target_iban", "TEST-TARGET-IBAN", "amount", 12.5, "status", "COMMITTED",
                            "timestamp", "2026-01-01 12:00:00+00")));
                }
                return;
            }
            respond(exchange, 500, Map.of("error", "Unexpected Ledger operation"));
            return;
        }
        if (!exchange.getRequestMethod().equals("GET") || !path.startsWith(prefix)) {
            respond(exchange, 500, Map.of("error", "Unexpected Ledger operation"));
            return;
        }
        String owner = URLDecoder.decode(path.substring(prefix.length()), StandardCharsets.UTF_8);
        lastOwner.set(owner);
        if (blocked.getCount() != 0 && owner.equals("user-a")) {
            blocked.countDown();
            try {
                if (!release.await(15, TimeUnit.SECONDS)) {
                    respond(exchange, 500, Map.of("error", "Test release timed out"));
                    return;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Test interrupted", e);
            }
        }
        if (owner.equals("missing-user")) {
            respond(exchange, 200, List.of());
            return;
        }
        respond(exchange, 200, List.of(account(owner)));
    }

    private Map<String, Object> account(String owner) {
        return account(owner, "ACC-TEST");
    }

    private Map<String, Object> account(String owner, String id) {
        return Map.of(
                "account_id", id, "user_id", owner, "iban", "TEST-IBAN",
                "holder_name", "Test Account", "balance", 100.0, "frozen_balance", 0.0);
    }

    private void respond(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] body = json.writeValueAsBytes(value);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }
}
