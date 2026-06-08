package com.smartretail.sis.adapter.inbound.rest;

import com.smartretail.sis.adapter.in.web.generated.model.ErrorResponse;
import com.smartretail.sis.domain.model.exception.DuplicateEventException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(DuplicateEventException.class)
    public ResponseEntity<ErrorResponse> handleDuplicate(DuplicateEventException ex) {
        return ResponseEntity.status(409).body(errorResponse(
                ErrorResponse.ErrorCodeEnum.DUPLICATE_EVENT,
                ex.getMessage()
        ));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        List<String> details = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .toList();
        ErrorResponse response = errorResponse(ErrorResponse.ErrorCodeEnum.VALIDATION_ERROR, "Request validation failed");
        response.setDetails(details);
        return ResponseEntity.badRequest().body(response);
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ErrorResponse> handleDataAccess(DataAccessException ex, HttpServletRequest req) {
        String cause = ex.getMostSpecificCause().getMessage();
        log.error("Data access error on {} [{}]: {}", req.getRequestURI(),
                ex.getClass().getSimpleName(), cause, ex);
        ErrorResponse response = errorResponse(ErrorResponse.ErrorCodeEnum.INTERNAL_ERROR,
                "Database error — see traceId in logs");
        response.setDetails(Map.of("exceptionType", ex.getClass().getSimpleName(), "cause", truncate(cause)));
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(response);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex, HttpServletRequest req) {
        log.error("Unexpected error on {} [{}]: {}",
                req.getRequestURI(), ex.getClass().getSimpleName(), ex.getMessage(), ex);
        ErrorResponse response = errorResponse(ErrorResponse.ErrorCodeEnum.INTERNAL_ERROR,
                "An unexpected error occurred");
        response.setDetails(Map.of("exceptionType", ex.getClass().getSimpleName(),
                "detail", truncate(ex.getMessage())));
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(response);
    }

    private ErrorResponse errorResponse(ErrorResponse.ErrorCodeEnum code, String message) {
        ErrorResponse response = new ErrorResponse(code, message, OffsetDateTime.now(ZoneOffset.UTC));
        response.setTraceId(MDC.get("traceId"));
        return response;
    }

    private static String truncate(String s) {
        if (s == null) return "null";
        return s.length() > 500 ? s.substring(0, 500) + "…" : s;
    }
}
