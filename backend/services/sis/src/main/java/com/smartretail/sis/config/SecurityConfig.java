package com.smartretail.sis.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {

    /** LOCAL mode: disable all auth — Lambda calls SIS directly without a token. */
    @Bean
    @Profile("local")
    public SecurityFilterChain localSecurity(HttpSecurity http) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }

    /** AWS mode: require a valid Cognito JWT on every request except the ingest endpoint.
     *  /v1/ingest/events is the Firehose delivery path — it uses static access-key auth
     *  (validated by FirehoseBatchFilter) and must also accept direct demo/test calls
     *  that carry no JWT.  All other endpoints remain JWT-protected. */
    @Bean
    @Profile("!local")
    public SecurityFilterChain awsSecurity(HttpSecurity http) throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/v1/ingest/events").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}));
        return http.build();
    }
}
