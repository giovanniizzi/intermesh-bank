package it.intermesh.bank.security;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.smallrye.config.EnvConfigSource;
import io.smallrye.config.PropertiesConfigSource;
import io.smallrye.config.SmallRyeConfig;
import io.smallrye.config.SmallRyeConfigBuilder;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;

class JwtConfigurationTest {

    @Test
    void issuerEnvironmentVariableDrivesDerivedJwksLocation() throws IOException {
        Properties properties = new Properties();
        try (InputStream input = getClass().getResourceAsStream("/application.properties")) {
            properties.load(input);
        }
        String issuer = "https://keycloak-test.example.invalid/realms/intermesh-bank";
        SmallRyeConfig config = new SmallRyeConfigBuilder()
                .withSources(new EnvConfigSource(Map.of("MP_JWT_VERIFY_ISSUER", issuer), 300),
                        new PropertiesConfigSource(properties, "application.properties", 100))
                .addDefaultInterceptors()
                .build();

        assertEquals(issuer, config.getValue("mp.jwt.verify.issuer", String.class));
        assertEquals(issuer + "/protocol/openid-connect/certs",
                config.getValue("mp.jwt.verify.publickey.location", String.class));
    }
}
