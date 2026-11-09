use proxy_wasm::traits::*;
use proxy_wasm::types::*;

proxy_wasm::main!({{
    proxy_wasm::set_log_level(LogLevel::Info);
    proxy_wasm::set_root_context(|_| -> Box<dyn RootContext> { Box::new(HttpHeadersRoot) });
}});

struct HttpHeadersRoot;

impl Context for HttpHeadersRoot {}

impl RootContext for HttpHeadersRoot {
    fn create_http_context(&self, _context_id: u32) -> Option<Box<dyn HttpContext>> {
        Some(Box::new(HttpHeadersHandler))
    }

    fn get_type(&self) -> Option<ContextType> {
        Some(ContextType::HttpContext)
    }
}

struct HttpHeadersHandler;

impl Context for HttpHeadersHandler {}

impl HttpContext for HttpHeadersHandler {
    fn on_http_request_headers(&mut self, _: usize, _: bool) -> Action {
        log::info!("[WasmPlugin-Rust] Intercepted request");

        if let Some(authority) = self.get_http_request_header(":authority") {
            log::info!("[WasmPlugin-Rust] Request to {}", authority);

            if authority.contains("fraud-analytics") {
                log::info!("[WasmPlugin-Rust] Intercepted request to Fraud Analytics ({})", authority);

                self.set_http_request_header("x-intermesh-channel", Some("Web-Channel-Hub"));
                self.set_http_request_header("x-intermesh-route-class", Some("Authenticated"));
            }
        }

        Action::Continue
    }
}