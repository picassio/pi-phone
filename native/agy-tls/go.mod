module agy-tls

// ML-KEM key exchange (SecP256r1MLKEM768, SecP384r1MLKEM1024) came in Go 1.26; scripts/build-agy-tls.sh builds it.
go 1.26.0

require (
	golang.org/x/net v0.63.0 // indirect
	golang.org/x/text v0.44.0 // indirect
)
