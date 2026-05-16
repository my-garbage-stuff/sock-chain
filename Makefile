# Build with bun (produces a native executable)
SRC := ./index.ts

TARGET := linux-x86_64 windows-x64

.PHONY: build

build: $(TARGET)

bun-install:
	bun install

$(TARGET): bun-install $(SRC)
	mkdir -p $(dir $@)
	# Build a single-file native binary with bun
	bun build $(SRC) --outfile=dist/sock5-chain-$@ --compile --target=bun-$@

clean:
	rm -rf dist node_modules bun.lock
