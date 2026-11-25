package streaming

import "netfusion/server/internal/config"

type Classifier struct {
	cfg config.StreamingConfig
}

func NewClassifier(cfg config.StreamingConfig) *Classifier {
	return &Classifier{cfg: cfg}
}

func (c *Classifier) ActiveProfile() string {
	return c.cfg.Profile
}
