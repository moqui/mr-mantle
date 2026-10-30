// Provider adapters return evidence. Financial writes happen only after their service frames have exited.
function assertNoProviderWrite() {
    if (
        /mantle\.account\.PaymentServices\.(dispatch|lookup)#PaymentGatewayAttempt(?:\b|$)/.test(
            ec.artifactExecution.getStackNameString()
        )
    )
        throw new Error("GATEWAY_PROVIDER_WRITE_REFUSED: Provider calls cannot change financial records")
}
;({assertNoProviderWrite})
