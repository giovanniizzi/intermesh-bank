package it.intermesh.bank.validation;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import it.intermesh.bank.dto.request.AccountCreationRequestDTO;
import it.intermesh.bank.dto.request.TransferRequestDTO;
import jakarta.annotation.Priority;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.Priorities;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.ext.MessageBodyReader;
import jakarta.ws.rs.ext.Provider;
import java.io.IOException;
import java.io.InputStream;
import java.lang.annotation.Annotation;
import java.lang.reflect.Type;

@Provider
@Consumes(MediaType.APPLICATION_JSON)
@Priority(Priorities.ENTITY_CODER - 1)
public class MonetaryRequestReader implements MessageBodyReader<Object> {
    @Inject ObjectMapper mapper;

    @Override
    public boolean isReadable(Class<?> type, Type genericType, Annotation[] annotations, MediaType mediaType) {
        return type == AccountCreationRequestDTO.class || type == TransferRequestDTO.class;
    }

    @Override
    public Object readFrom(Class<Object> type, Type genericType, Annotation[] annotations,
            MediaType mediaType, MultivaluedMap<String, String> headers, InputStream input) throws IOException {
        byte[] body = input.readNBytes((64 << 10) + 1);
        if (body.length > (64 << 10)) {
            throw MonetaryAmounts.invalidRequest();
        }
        try {
            return mapper.readerFor(type).with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readValue(body);
        } catch (IOException e) {
            throw MonetaryAmounts.invalidRequest();
        }
    }
}
