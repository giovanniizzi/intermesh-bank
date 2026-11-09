package it.intermesh.bank.validation;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonMappingException;
import java.io.IOException;
import java.math.BigDecimal;

public class StrictDecimalDeserializer extends JsonDeserializer<BigDecimal> {
    @Override
    public BigDecimal deserialize(JsonParser parser, DeserializationContext context) throws IOException {
        if (!parser.hasToken(JsonToken.VALUE_NUMBER_INT) && !parser.hasToken(JsonToken.VALUE_NUMBER_FLOAT)) {
            throw JsonMappingException.from(parser, "Invalid monetary amount");
        }
        String token = parser.getText();
        if (token.length() > 256) {
            throw JsonMappingException.from(parser, "Invalid monetary amount");
        }
        try {
            int index = Math.max(token.indexOf('e'), token.indexOf('E'));
            if (index >= 0) {
                int exponent = Integer.parseInt(token.substring(index + 1));
                if (exponent < -1024 || exponent > 1024) {
                    throw new NumberFormatException();
                }
            }
            return new BigDecimal(token);
        } catch (NumberFormatException e) {
            throw JsonMappingException.from(parser, "Invalid monetary amount");
        }
    }
}
