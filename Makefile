# Build with bun (produces a native executable)
all: clean build

build:
	mkdir -p $(dir $@)
	# Build a single-file native binary with bun
	bun ./build.ts
clean:
	rm -rf dist node_modules bun.lock
