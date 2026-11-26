package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"netfusion/server/internal/api"
	"netfusion/server/internal/auth"
	"netfusion/server/internal/config"
	"netfusion/server/internal/database"
	"netfusion/server/internal/metrics"
	"netfusion/server/internal/network"
)

func main() {
	cfgPath := os.Getenv("NETFUSION_CONFIG")
	if cfgPath == "" {
		cfgPath = "configs/server.json"
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("failed to load configuration: %v", err)
	}

	dbPath := os.Getenv("NETFUSION_DB_PATH")
	if dbPath == "" {
		dbPath = "C:\\NetFusion\\data\\netfusion.db"
	}

	store, err := database.Open(dbPath)
	if err != nil {
		log.Fatalf("failed to initialize sqlite store: %v", err)
	}
	defer store.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	timeoutS := 15
	if raw := os.Getenv("NETFUSION_HEARTBEAT_TIMEOUT_SECONDS"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 5 {
			timeoutS = v
		}
	}

	collector := metrics.NewCollector(store)
	discoverer := network.NewDiscoverer()
	monitor := network.NewMonitor(discoverer, collector, time.Duration(cfg.Network.MonitorIntervalSeconds)*time.Second)
	pairingSvc := auth.NewPairingService(store, timeoutS)

	go monitor.Start(ctx)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = pairingSvc.EvaluateTimeouts()
			}
		}
	}()

	httpSrv := api.NewServer(cfg, store, discoverer, collector, monitor, pairingSvc)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil {
			log.Printf("api server stopped: %v", err)
		}
	}()

	log.Printf("NetFusion v%s server started (DB: %s)", cfg.Application.Version, dbPath)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down NetFusion server cleanly...")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}
