.PHONY: build run client clean

build:
	go build -o bin/talkd-service ./cmd/talkd-service
	go build -o bin/talkd-client ./cmd/talkd-client

run: build
	./bin/talkd-service

client: build
	./bin/talkd-client -mode tts -text "Hello from talkd." -out /tmp/talkd.pcm

clean:
	rm -rf bin
