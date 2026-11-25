package scheduler

type WeightedHealthScheduler struct {
	algorithm string
}

func NewWeightedHealthScheduler(algorithm string) *WeightedHealthScheduler {
	if algorithm == "" {
		algorithm = "weighted_health"
	}
	return &WeightedHealthScheduler{algorithm: algorithm}
}

func (s *WeightedHealthScheduler) Algorithm() string {
	return s.algorithm
}
