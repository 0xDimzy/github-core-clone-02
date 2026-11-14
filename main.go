// main.go — entrypoint: serve the forge, registering with the harness when
// MAKEFUN_ENV_URL is set (trial container), or standalone otherwise.
//
// Harness lifecycle (the grader's trial container sets MAKEFUN_ENV_URL):
//  1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial).
//  2. Create the server and listen(0): the kernel picks a free port.
//  3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register wins.
//  4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}.
//  5. Close the server and exit 0.
//
// Standalone (local conformance runs, no MAKEFUN_ENV_URL):
//
//	Bind PORT when set, else an ephemeral port; write server.toml with the
//	port and serve until killed.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func sleep(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

func runHarness(envURL string) error {
	handler := createApp()
	ln, err := createServer(handler, 0)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if port == 0 {
		return fmt.Errorf("no port assigned")
	}
	base := strings.TrimRight(envURL, "/")
	body, _ := json.Marshal(map[string]int{"port": port})
	reg, err := http.Post(base+"/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	reg.Body.Close()
	if reg.StatusCode < 200 || reg.StatusCode >= 300 {
		return fmt.Errorf("register failed: %d", reg.StatusCode)
	}
	// Poll /done until the env says the trial is over, then exit 0.
	delay := 100
	for {
		done := false
		func() {
			defer func() { _ = recover() }()
			client := &http.Client{Timeout: 30 * time.Second}
			res, err := client.Get(base + "/done")
			if err == nil {
				defer res.Body.Close()
				if res.StatusCode >= 200 && res.StatusCode < 300 {
					var parsed struct {
						Done bool `json:"done"`
					}
					if json.NewDecoder(res.Body).Decode(&parsed) == nil && parsed.Done {
						done = true
					}
				}
			}
		}()
		if done {
			break
		}
		sleep(delay)
		delay *= 2
		if delay > 2000 {
			delay = 2000
		}
	}
	ln.Close()
	os.Exit(0)
	return nil
}

func runStandalone(portEnv int) error {
	handler := createApp()
	ln, err := createServer(handler, portEnv)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if port == 0 {
		return fmt.Errorf("no port assigned")
	}
	if err := os.WriteFile("server.toml", []byte(fmt.Sprintf("port = %d\n", port)), 0644); err != nil {
		return err
	}
	fmt.Printf("forge listening on http://127.0.0.1:%d\n", port)
	select {}
}

func main() {
	envURL := os.Getenv("MAKEFUN_ENV_URL")
	port := 0
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}
	var err error
	if envURL != "" {
		err = runHarness(envURL)
	} else {
		err = runStandalone(port)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[forge] fatal: %v\n", err)
		os.Exit(1)
	}
}
